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
	apiSrv := api.New(queries, sched, jwtSecret, webhookSecret)

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(corsMiddleware(allowedOrigin))

	// Root route — a lightweight 200 so uptime monitors (UptimeRobot) and a
	// human hitting the base URL get a friendly response instead of a 404.
	r.GET("/", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"service": "driftwatch-backend",
			"status":  "ok",
			"docs":    "https://github.com/souvik-biswas-dev/driftwatch",
		})
	})

	// Liveness — process is up. Cheap; safe to hit frequently.
	r.GET("/health", func(c *gin.Context) {
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

	// 9. Graceful shutdown.
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
	allow := strings.Split(allowedOrigin, ",")
	for i, v := range allow {
		allow[i] = strings.TrimSpace(v)
	}
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" {
			for _, a := range allow {
				if a == "*" || a == origin {
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
