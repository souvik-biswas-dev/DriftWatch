// Package migrations bundles the *.sql migration files into the binary
// so the server can apply them at startup without needing the source tree
// to be present on disk.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
