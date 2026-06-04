package github

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	gogithub "github.com/google/go-github/v60/github"
	"golang.org/x/oauth2"
	"gopkg.in/yaml.v3"

	"github.com/souvik-biswas-dev/driftwatch/internal/docker"
)

type Client struct {
	gh *gogithub.Client
}

// newGHClient builds a go-github client. Empty token → unauthenticated (works
// for public repos, 60 req/hr per IP). With a token → authenticated (private
// repos + higher rate limit).
func newGHClient(token string) *gogithub.Client {
	if token == "" {
		return gogithub.NewClient(nil)
	}
	ts := oauth2.StaticTokenSource(&oauth2.Token{AccessToken: token})
	return gogithub.NewClient(oauth2.NewClient(context.Background(), ts))
}

// NewClient builds a client with an optional operator-wide fallback token.
func NewClient(token string) *Client {
	return &Client{gh: newGHClient(token)}
}

type Repo struct {
	FullName    string `json:"full_name"`
	Name        string `json:"name"`
	Owner       string `json:"owner"`
	Private     bool   `json:"private"`
	Description string `json:"description"`
}

type Branch struct {
	Name string `json:"name"`
}

// ListUserRepos returns all repos (public + private) the token can access,
// across all pages. Used by the dashboard repo picker.
func (c *Client) ListUserRepos(ctx context.Context, token string) ([]Repo, error) {
	gh := newGHClient(token)
	var all []Repo
	opts := &gogithub.RepositoryListByAuthenticatedUserOptions{
		Sort:        "updated",
		ListOptions: gogithub.ListOptions{PerPage: 100},
	}
	for {
		repos, resp, err := gh.Repositories.ListByAuthenticatedUser(ctx, opts)
		if err != nil {
			return nil, fmt.Errorf("github: list repos: %w", err)
		}
		for _, r := range repos {
			owner := ""
			if r.Owner != nil {
				owner = r.Owner.GetLogin()
			}
			all = append(all, Repo{
				FullName:    r.GetFullName(),
				Name:        r.GetName(),
				Owner:       owner,
				Private:     r.GetPrivate(),
				Description: r.GetDescription(),
			})
		}
		if resp.NextPage == 0 {
			break
		}
		opts.Page = resp.NextPage
	}
	return all, nil
}

// ListRepoBranches returns all branches for a repo.
func (c *Client) ListRepoBranches(ctx context.Context, owner, repo, token string) ([]Branch, error) {
	gh := newGHClient(token)
	var all []Branch
	opts := &gogithub.BranchListOptions{ListOptions: gogithub.ListOptions{PerPage: 100}}
	for {
		branches, resp, err := gh.Repositories.ListBranches(ctx, owner, repo, opts)
		if err != nil {
			return nil, fmt.Errorf("github: list branches: %w", err)
		}
		for _, b := range branches {
			all = append(all, Branch{Name: b.GetName()})
		}
		if resp.NextPage == 0 {
			break
		}
		opts.Page = resp.NextPage
	}
	return all, nil
}

type DockerCompose struct {
	Services map[string]Service `yaml:"services"`
}

type Service struct {
	Image       string      `yaml:"image"`
	Environment interface{} `yaml:"environment"`
	Ports       []string    `yaml:"ports"`
}

// FetchDeclaredConfigWithToken fetches a project's declared compose using a
// per-project token. Empty token falls back to the client's default (operator)
// credentials — fine for public repos. This is what the multi-user scheduler
// calls so each user's private repo is read with that user's own token.
func (c *Client) FetchDeclaredConfigWithToken(ctx context.Context, owner, repo, branch, token string) (*docker.LiveSnapshot, error) {
	gh := c.gh
	if token != "" {
		gh = newGHClient(token)
	}
	return fetchDeclaredConfig(ctx, gh, owner, repo, branch)
}

// FetchDeclaredConfig uses the client's default credentials (backward compatible).
func (c *Client) FetchDeclaredConfig(ctx context.Context, owner, repo, branch string) (*docker.LiveSnapshot, error) {
	return fetchDeclaredConfig(ctx, c.gh, owner, repo, branch)
}

func fetchDeclaredConfig(ctx context.Context, gh *gogithub.Client, owner, repo, branch string) (*docker.LiveSnapshot, error) {
	fileContent, _, resp, err := gh.Repositories.GetContents(
		ctx,
		owner, repo, "docker-compose.yml",
		&gogithub.RepositoryContentGetOptions{Ref: branch},
	)
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusNotFound {
			return nil, fmt.Errorf("docker-compose.yml not found in %s/%s@%s", owner, repo, branch)
		}
		return nil, fmt.Errorf("github: fetch docker-compose.yml: %w", err)
	}
	if fileContent == nil {
		return nil, fmt.Errorf("github: %s/%s/docker-compose.yml is a directory, not a file", owner, repo)
	}

	// GetContent transparently base64-decodes the file body when the
	// API response sets Encoding="base64" (the GitHub default).
	raw, err := fileContent.GetContent()
	if err != nil {
		return nil, fmt.Errorf("github: decode docker-compose.yml: %w", err)
	}

	var compose DockerCompose
	if err := yaml.Unmarshal([]byte(raw), &compose); err != nil {
		return nil, fmt.Errorf("github: parse docker-compose.yml: %w", err)
	}

	snap := &docker.LiveSnapshot{
		Containers: make([]docker.ContainerState, 0, len(compose.Services)),
		CapturedAt: time.Now().UTC(),
	}
	for name, svc := range compose.Services {
		snap.Containers = append(snap.Containers, docker.ContainerState{
			Name:    name,
			Image:   svc.Image,
			Env:     normalizeEnv(svc.Environment),
			Ports:   append([]string(nil), svc.Ports...),
			Running: true,
		})
	}
	return snap, nil
}

// normalizeEnv accepts the two YAML shapes docker-compose allows for
// `environment` and returns a uniform map[string]string:
//
//	environment:               environment:
//	  - APP_ENV=prod      vs.    APP_ENV: prod
//	  - DEBUG=true               DEBUG: "true"
func normalizeEnv(raw interface{}) map[string]string {
	out := make(map[string]string)
	if raw == nil {
		return out
	}
	switch v := raw.(type) {
	case []interface{}:
		for _, item := range v {
			s, ok := item.(string)
			if !ok {
				continue
			}
			k, val, found := strings.Cut(s, "=")
			if found {
				out[k] = val
			} else {
				out[k] = ""
			}
		}
	case map[string]interface{}:
		for k, val := range v {
			out[k] = fmt.Sprint(val)
		}
	case map[interface{}]interface{}:
		for k, val := range v {
			ks, ok := k.(string)
			if !ok {
				continue
			}
			out[ks] = fmt.Sprint(val)
		}
	}
	return out
}
