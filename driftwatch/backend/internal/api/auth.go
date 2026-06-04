package api

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/souvik-biswas-dev/driftwatch/internal/db"
)

type registerRequest struct {
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required,min=8"`
}

type loginRequest struct {
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required"`
}

func (a *API) handleRegister(c *gin.Context) {
	var req registerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		respondError(c, http.StatusBadRequest, err.Error(), "VALIDATION_ERROR")
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		respondError(c, http.StatusInternalServerError, "could not hash password", "HASH_ERROR")
		return
	}

	user, err := a.queries.CreateUser(c.Request.Context(), db.CreateUserParams{
		Email:        req.Email,
		PasswordHash: string(hash),
	})
	if err != nil {
		// Most likely a unique-violation on email.
		respondError(c, http.StatusConflict, "email already registered", "EMAIL_TAKEN")
		return
	}

	respond(c, http.StatusCreated, gin.H{
		"id":    user.ID,
		"email": user.Email,
	}, "user created")
}

func (a *API) handleLogin(c *gin.Context) {
	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		respondError(c, http.StatusBadRequest, err.Error(), "VALIDATION_ERROR")
		return
	}

	user, err := a.queries.GetUserByEmail(c.Request.Context(), req.Email)
	if err != nil {
		// Generic message — don't leak whether the email exists.
		respondError(c, http.StatusUnauthorized, "invalid credentials", "INVALID_CREDENTIALS")
		return
	}

	// GitHub-OAuth users have no password set; reject password login for them.
	if user.PasswordHash == nil || *user.PasswordHash == "" {
		respondError(c, http.StatusUnauthorized, "invalid credentials", "INVALID_CREDENTIALS")
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(*user.PasswordHash), []byte(req.Password)); err != nil {
		respondError(c, http.StatusUnauthorized, "invalid credentials", "INVALID_CREDENTIALS")
		return
	}

	now := time.Now()
	claims := Claims{
		UserID: user.ID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			Issuer:    "driftwatch",
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString(a.jwtSecret)
	if err != nil {
		respondError(c, http.StatusInternalServerError, "could not sign token", "TOKEN_ERROR")
		return
	}

	respond(c, http.StatusOK, gin.H{
		"token":      signed,
		"expires_at": claims.ExpiresAt.Time,
	}, "login successful")
}
