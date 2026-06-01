package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/YOURUSERNAME/driftwatch/internal/crypto"
	"github.com/YOURUSERNAME/driftwatch/internal/db"
)

// OAuthConfig holds the GitHub OAuth app credentials and the dashboard URL we
// redirect back to after login.
type OAuthConfig struct {
	ClientID     string
	ClientSecret string
	// DashboardURL is where the callback sends the browser with the issued JWT,
	// e.g. https://driftwatch.pages.dev. The token is appended as #token=...
	DashboardURL string
	// BackendURL, when set, is this service's external base URL used to build the
	// OAuth redirect_uri (e.g. https://driftwatch-3drv.onrender.com). If empty it
	// is reconstructed from the request.
	BackendURL string
}

// Enabled reports whether GitHub OAuth is configured.
func (o OAuthConfig) Enabled() bool {
	return o.ClientID != "" && o.ClientSecret != ""
}

const githubAuthorizeURL = "https://github.com/login/oauth/authorize"
const githubTokenURL = "https://github.com/login/oauth/access_token"
const githubUserURL = "https://api.github.com/user"
const githubEmailsURL = "https://api.github.com/user/emails"

// handleGithubLogin redirects the browser to GitHub's consent screen. We request
// `repo` and `read:user` scopes so the same token can later read the user's
// private compose files.
func (a *API) handleGithubLogin(c *gin.Context) {
	if !a.oauth.Enabled() {
		respondError(c, http.StatusServiceUnavailable, "GitHub login is not configured", "OAUTH_DISABLED")
		return
	}

	// CSRF state: random token round-tripped via a short-lived cookie.
	state := randomToken()
	c.SetCookie("dw_oauth_state", state, 600, "/", "", true, true)

	q := url.Values{}
	q.Set("client_id", a.oauth.ClientID)
	q.Set("redirect_uri", a.backendBaseURL(c)+"/api/auth/github/callback")
	q.Set("scope", "read:user user:email repo")
	q.Set("state", state)
	q.Set("allow_signup", "true")

	c.Redirect(http.StatusFound, githubAuthorizeURL+"?"+q.Encode())
}

// handleGithubCallback completes the OAuth dance: verify state, exchange the
// code for an access token, fetch the GitHub profile, upsert the user, issue our
// own JWT, and redirect to the dashboard with the token in the URL fragment.
func (a *API) handleGithubCallback(c *gin.Context) {
	if !a.oauth.Enabled() {
		respondError(c, http.StatusServiceUnavailable, "GitHub login is not configured", "OAUTH_DISABLED")
		return
	}

	// Verify CSRF state.
	wantState, _ := c.Cookie("dw_oauth_state")
	gotState := c.Query("state")
	if wantState == "" || gotState == "" || wantState != gotState {
		a.redirectToDashboardError(c, "state_mismatch")
		return
	}
	c.SetCookie("dw_oauth_state", "", -1, "/", "", true, true)

	code := c.Query("code")
	if code == "" {
		a.redirectToDashboardError(c, "missing_code")
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()

	accessToken, err := a.exchangeGithubCode(ctx, code, a.backendBaseURL(c)+"/api/auth/github/callback")
	if err != nil {
		a.redirectToDashboardError(c, "token_exchange_failed")
		return
	}

	profile, err := fetchGithubProfile(ctx, accessToken)
	if err != nil {
		a.redirectToDashboardError(c, "profile_fetch_failed")
		return
	}

	// Encrypt the OAuth token before storing — it's reused for private repos.
	encToken, err := crypto.Encrypt(accessToken)
	if err != nil {
		a.redirectToDashboardError(c, "encrypt_failed")
		return
	}

	user, err := a.queries.UpsertGithubUser(ctx, db.UpsertGithubUserParams{
		Email:                profile.Email,
		GithubID:             profile.ID,
		GithubLogin:          profile.Login,
		AvatarURL:            profile.AvatarURL,
		GithubTokenEncrypted: encToken,
	})
	if err != nil {
		a.redirectToDashboardError(c, "user_upsert_failed")
		return
	}

	signed, err := a.issueJWT(user.ID)
	if err != nil {
		a.redirectToDashboardError(c, "token_sign_failed")
		return
	}

	// Hand the JWT to the SPA via the URL fragment (never sent to a server, not
	// logged). The dashboard's /auth/callback page reads it and stores it.
	dest := strings.TrimRight(a.oauth.DashboardURL, "/") + "/auth/callback#token=" + url.QueryEscape(signed)
	c.Redirect(http.StatusFound, dest)
}

// issueJWT mints a 24h DriftWatch session token for a user id.
func (a *API) issueJWT(userID uuid.UUID) (string, error) {
	now := time.Now()
	claims := Claims{
		UserID: userID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			Issuer:    "driftwatch",
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(a.jwtSecret)
}

func (a *API) exchangeGithubCode(ctx context.Context, code, redirectURI string) (string, error) {
	form := url.Values{}
	form.Set("client_id", a.oauth.ClientID)
	form.Set("client_secret", a.oauth.ClientSecret)
	form.Set("code", code)
	form.Set("redirect_uri", redirectURI)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, githubTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))

	var out struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", err
	}
	if out.AccessToken == "" {
		return "", fmt.Errorf("github: no access token (%s)", out.Error)
	}
	return out.AccessToken, nil
}

type githubProfile struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	AvatarURL string `json:"avatar_url"`
	Email     string `json:"email"`
}

func fetchGithubProfile(ctx context.Context, accessToken string) (githubProfile, error) {
	var p githubProfile
	if err := githubGet(ctx, githubUserURL, accessToken, &p); err != nil {
		return p, err
	}
	// The /user email is null when the user keeps it private; fall back to the
	// primary verified email from /user/emails.
	if p.Email == "" {
		var emails []struct {
			Email    string `json:"email"`
			Primary  bool   `json:"primary"`
			Verified bool   `json:"verified"`
		}
		if err := githubGet(ctx, githubEmailsURL, accessToken, &emails); err == nil {
			for _, e := range emails {
				if e.Primary && e.Verified {
					p.Email = e.Email
					break
				}
			}
		}
	}
	return p, nil
}

func githubGet(ctx context.Context, urlStr, accessToken string, out interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, urlStr, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "DriftWatch")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("github GET %s: status %d", urlStr, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<18))
	if err != nil {
		return err
	}
	return json.Unmarshal(body, out)
}

// redirectToDashboardError sends the browser back to the dashboard login with an
// error code in the query string, so the SPA can show a toast.
func (a *API) redirectToDashboardError(c *gin.Context, code string) {
	dest := strings.TrimRight(a.oauth.DashboardURL, "/") + "/login?error=" + url.QueryEscape(code)
	c.Redirect(http.StatusFound, dest)
}

// backendBaseURL reconstructs this backend's external base URL from the request
// (honoring proxies via X-Forwarded-Proto), used to build the OAuth redirect_uri.
func (a *API) backendBaseURL(c *gin.Context) string {
	if a.oauth.BackendURL != "" {
		return strings.TrimRight(a.oauth.BackendURL, "/")
	}
	scheme := "https"
	if proto := c.GetHeader("X-Forwarded-Proto"); proto != "" {
		scheme = proto
	} else if c.Request.TLS == nil {
		scheme = "http"
	}
	return scheme + "://" + c.Request.Host
}

func randomToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
