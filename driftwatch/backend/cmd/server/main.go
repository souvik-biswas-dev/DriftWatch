package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
	"github.com/redis/go-redis/v9"

	"github.com/YOURUSERNAME/driftwatch/internal/alerts"
	"github.com/YOURUSERNAME/driftwatch/internal/api"
	"github.com/YOURUSERNAME/driftwatch/internal/crypto"
	"github.com/YOURUSERNAME/driftwatch/internal/db"
	"github.com/YOURUSERNAME/driftwatch/internal/gemini"
	"github.com/YOURUSERNAME/driftwatch/internal/github"
	"github.com/YOURUSERNAME/driftwatch/internal/scheduler"
	"github.com/YOURUSERNAME/driftwatch/migrations"
)

func main() {
	if err := run(); err != nil {
		slog.Error("server fatal", "error", err)
		os.Exit(1)
	}
}

func run() error {
	if err := godotenv.Load(); err != nil {
		slog.Info("no .env file found; using process environment")
	}

	port := getenv("PORT", "8080")
	databaseURL := mustEnv("DATABASE_URL")
	redisURL := mustEnv("REDIS_URL")
	jwtSecret := mustEnv("JWT_SECRET")

	geminiKey := os.Getenv("GEMINI_API_KEY")
	githubToken := os.Getenv("GITHUB_TOKEN")
	discordURL := os.Getenv("DISCORD_WEBHOOK_URL")
	webhookSecret := os.Getenv("WEBHOOK_SECRET")
	allowedOrigin := getenv("ALLOWED_ORIGIN", "http://localhost:5173")

	// GitHub OAuth (sign-in). DASHBOARD_URL is where users are sent back with
	// their session token; BACKEND_URL builds the OAuth redirect_uri.
	oauthCfg := api.OAuthConfig{
		ClientID:     os.Getenv("GITHUB_OAUTH_CLIENT_ID"),
		ClientSecret: os.Getenv("GITHUB_OAUTH_CLIENT_SECRET"),
		DashboardURL: getenv("DASHBOARD_URL", "http://localhost:5173"),
		BackendURL:   os.Getenv("BACKEND_URL"),
	}
	if !oauthCfg.Enabled() {
		slog.Warn("GitHub OAuth not configured — set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET to enable sign-in")
	}

	// Encryption key for users' per-project GitHub tokens at rest. Optional for
	// local dev (tokens stored plaintext) but REQUIRED for a real multi-user
	// deploy. Warn loudly if unset so it isn't forgotten in production.
	crypto.Init(os.Getenv("ENCRYPTION_KEY"))
	if !crypto.Enabled() {
		slog.Warn("ENCRYPTION_KEY not set — per-project GitHub tokens will be stored UNENCRYPTED; set it before going multi-user")
	}

	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// 1. Migrations — applied before opening the app's connection pool so we
	// fail fast if the database is unreachable or schema is incompatible.
	if err := runMigrations(databaseURL); err != nil {
		return fmt.Errorf("migrations: %w", err)
	}
	slog.Info("migrations applied")

	// 2. Postgres pool (pgx/v5).
	poolCfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return fmt.Errorf("parse database url: %w", err)
	}
	poolCfg.MaxConns = 10
	poolCfg.MinConns = 2
	poolCfg.MaxConnLifetime = 30 * time.Minute
	poolCfg.MaxConnIdleTime = 5 * time.Minute

	pool, err := pgxpool.NewWithConfig(rootCtx, poolCfg)
	if err != nil {
		return fmt.Errorf("open db pool: %w", err)
	}
	defer pool.Close()

	pingCtx, pingCancel := context.WithTimeout(rootCtx, 5*time.Second)
	if err := pool.Ping(pingCtx); err != nil {
		pingCancel()
		return fmt.Errorf("ping postgres: %w", err)
	}
	pingCancel()
	slog.Info("postgres connected", "max_conns", poolCfg.MaxConns)

	// 3. Redis (Upstash supports rediss:// URLs out of the box).
	redisOpts, err := redis.ParseURL(redisURL)
	if err != nil {
		return fmt.Errorf("parse redis url: %w", err)
	}
	rdb := redis.NewClient(redisOpts)
	defer rdb.Close()

	pingCtx, pingCancel = context.WithTimeout(rootCtx, 5*time.Second)
	if err := rdb.Ping(pingCtx).Err(); err != nil {
		pingCancel()
		return fmt.Errorf("ping redis: %w", err)
	}
	pingCancel()
	slog.Info("redis connected")

	// 4. sqlc queries bound to the pool.
	queries := db.New(pool)

	// 5. Integration clients. Docker is created on demand per-project, so
	// the scheduler doesn't hold a single docker.Client.
	ghClient := github.NewClient(githubToken)
	geminiClient := gemini.NewClient(geminiKey)
	alertsClient := alerts.NewClient(discordURL)

	// 6. Scheduler.
	sched := scheduler.NewScheduler(rdb, queries, ghClient, geminiClient, alertsClient)

	// 7. Register existing projects, then start the cron.
	sched.LoadAllProjects(rootCtx)
	sched.Start()
	defer sched.Stop()

	// 8. HTTP layer.
	apiSrv := api.New(queries, sched, jwtSecret, webhookSecret, oauthCfg)

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(corsMiddleware(allowedOrigin))

	// Root route — a lightweight 200 so uptime monitors (UptimeRobot) and a
	// human hitting the base URL get a friendly response instead of a 404.
	// GET *and* HEAD: UptimeRobot's free tier probes with HEAD, and Gin does
	// not auto-route HEAD to GET handlers, so a HEAD-only probe would 404.
	r.Match([]string{http.MethodGet, http.MethodHead}, "/", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"service": "driftwatch-backend",
			"status":  "ok",
			"docs":    "https://github.com/souvik-biswas-dev/driftwatch",
		})
	})

	// Liveness — process is up. Cheap; safe to hit frequently. HEAD too, for
	// the same monitor-probe reason as the root route above.
	r.Match([]string{http.MethodGet, http.MethodHead}, "/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// Readiness — also verifies Postgres + Redis are reachable. Returns 503 if
	// a dependency is down so a monitor can distinguish "process up" from
	// "fully healthy". Each check has a short timeout to stay snappy.
	r.GET("/status", func(c *gin.Context) {
		out := gin.H{"status": "ok", "postgres": "ok", "redis": "ok"}
		code := http.StatusOK

		pgCtx, pgCancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
		if err := pool.Ping(pgCtx); err != nil {
			out["postgres"] = "down"
			out["status"] = "degraded"
			code = http.StatusServiceUnavailable
		}
		pgCancel()

		rCtx, rCancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
		if err := rdb.Ping(rCtx).Err(); err != nil {
			out["redis"] = "down"
			out["status"] = "degraded"
			code = http.StatusServiceUnavailable
		}
		rCancel()

		c.JSON(code, out)
	})

	apiSrv.RegisterRoutes(r)

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
	}

	serverErr := make(chan error, 1)
	go func() {
		slog.Info("HTTP server listening", "port", port)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
		close(serverErr)
	}()

	// 9. Self-ping to prevent Render free-tier sleep (spins down after 15 min
	// of inactivity). Requires BACKEND_URL env var; silently skipped if unset.
	if backendURL := os.Getenv("BACKEND_URL"); backendURL != "" {
		pingURL := strings.TrimRight(backendURL, "/") + "/health"
		go func() {
			ticker := time.NewTicker(10 * time.Minute)
			defer ticker.Stop()
			client := &http.Client{Timeout: 10 * time.Second}
			for {
				select {
				case <-rootCtx.Done():
					return
				case <-ticker.C:
					resp, err := client.Get(pingURL)
					if err != nil {
						slog.Warn("keep-alive ping failed", "error", err)
					} else {
						resp.Body.Close()
					}
				}
			}
		}()
		slog.Info("keep-alive self-ping enabled", "url", pingURL, "interval", "10m")
	}

	// 10. Graceful shutdown.

	select {
	case err := <-serverErr:
		return fmt.Errorf("http listen: %w", err)
	case <-rootCtx.Done():
		slog.Info("shutdown signal received")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("http shutdown: %w", err)
	}
	slog.Info("server stopped cleanly")
	return nil
}

func runMigrations(databaseURL string) error {
	src, err := iofs.New(migrations.FS, ".")
	if err != nil {
		return fmt.Errorf("load embedded migrations: %w", err)
	}
	m, err := migrate.NewWithSourceInstance("iofs", src, databaseURL)
	if err != nil {
		return fmt.Errorf("migrate init: %w", err)
	}
	defer func() {
		srcErr, dbErr := m.Close()
		if srcErr != nil {
			slog.Warn("migrate close source", "error", srcErr)
		}
		if dbErr != nil {
			slog.Warn("migrate close database", "error", dbErr)
		}
	}()
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("migrate up: %w", err)
	}
	return nil
}

func corsMiddleware(allowedOrigin string) gin.HandlerFunc {
	// Normalize the configured origins: trim spaces and any trailing slash, so
	// "https://x.pages.dev/" and "https://x.pages.dev" both match the browser's
	// Origin header (which never has a trailing slash).
	allow := strings.Split(allowedOrigin, ",")
	for i, v := range allow {
		allow[i] = strings.TrimRight(strings.TrimSpace(v), "/")
	}
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" {
			reqOrigin := strings.TrimRight(origin, "/")
			for _, a := range allow {
				// Exact match, wildcard, or any Cloudflare Pages preview
				// subdomain of the configured project (*.driftwatch.pages.dev),
				// since each deploy gets a new hashed subdomain.
				if a == "*" || a == reqOrigin || isPagesPreview(reqOrigin, a) {
					c.Header("Access-Control-Allow-Origin", origin)
					c.Header("Vary", "Origin")
					break
				}
			}
		}
		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-DriftWatch-Secret")
		c.Header("Access-Control-Max-Age", "300")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// isPagesPreview reports whether reqOrigin is a Cloudflare Pages preview
// subdomain of the configured production origin. E.g. allowed
// "https://driftwatch.pages.dev" also accepts
// "https://247bc5d9.driftwatch.pages.dev".
func isPagesPreview(reqOrigin, allowed string) bool {
	const scheme = "https://"
	if !strings.HasPrefix(allowed, scheme) || !strings.HasPrefix(reqOrigin, scheme) {
		return false
	}
	host := strings.TrimPrefix(allowed, scheme) // e.g. driftwatch.pages.dev
	if !strings.HasSuffix(host, ".pages.dev") {
		return false
	}
	return strings.HasSuffix(reqOrigin, "."+host)
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		slog.Error("required environment variable missing", "key", key)
		os.Exit(1)
	}
	return v
}
