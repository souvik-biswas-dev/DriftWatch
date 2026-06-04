package api

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/souvik-biswas-dev/driftwatch/internal/crypto"
)

// handleListUserRepos returns the authenticated user's GitHub repos so the
// dashboard can show a picker instead of free-text inputs.
func (a *API) handleListUserRepos(c *gin.Context) {
	userID, ok := currentUserID(c)
	if !ok {
		respondError(c, http.StatusUnauthorized, "auth required", "AUTH_MISSING")
		return
	}

	enc, err := a.queries.GetUserGithubToken(c.Request.Context(), userID)
	if err != nil || enc == "" {
		respondError(c, http.StatusBadRequest, "no GitHub token — log in with GitHub first", "NO_GITHUB_TOKEN")
		return
	}
	token, err := crypto.Decrypt(enc)
	if err != nil {
		respondError(c, http.StatusInternalServerError, "could not read GitHub token", "DECRYPT_ERROR")
		return
	}

	repos, err := a.githubClient.ListUserRepos(c.Request.Context(), token)
	if err != nil {
		respondError(c, http.StatusBadGateway, "could not list GitHub repos", "GITHUB_ERROR")
		return
	}
	respond(c, http.StatusOK, repos, "")
}

// handleListRepoBranches returns the branches for a specific repo.
func (a *API) handleListRepoBranches(c *gin.Context) {
	userID, ok := currentUserID(c)
	if !ok {
		respondError(c, http.StatusUnauthorized, "auth required", "AUTH_MISSING")
		return
	}

	owner := c.Param("owner")
	repo := c.Param("repo")

	enc, err := a.queries.GetUserGithubToken(c.Request.Context(), userID)
	if err != nil || enc == "" {
		respondError(c, http.StatusBadRequest, "no GitHub token — log in with GitHub first", "NO_GITHUB_TOKEN")
		return
	}
	token, err := crypto.Decrypt(enc)
	if err != nil {
		respondError(c, http.StatusInternalServerError, "could not read GitHub token", "DECRYPT_ERROR")
		return
	}

	branches, err := a.githubClient.ListRepoBranches(c.Request.Context(), owner, repo, token)
	if err != nil {
		respondError(c, http.StatusBadGateway, "could not list branches", "GITHUB_ERROR")
		return
	}
	respond(c, http.StatusOK, branches, "")
}
