// Copyright (c) 2026 Circle Internet Services, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
//
// SPDX-License-Identifier: MIT

package keystore

import (
	"context"
	"os"
	"strings"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
	"github.com/CircleCI-Labs/circleci-editor/internal/envcompat"
)

// KeyEnvVarPrefix begins the name of every environment variable that can
// supply a key without storing one (see KeyEnvVar). It is namespaced to this
// tool on purpose: a vendor-conventional name like ANTHROPIC_API_KEY is
// deliberately *not* read, because a key exported in a shell for some other
// program is not consent to spend it here, and "why is the editor using a key
// I never gave it" is exactly the kind of surprise this project's
// bring-your-own-key design exists to avoid.
const KeyEnvVarPrefix = "CIRCLECI_EDITOR_AI_KEY_"

// SupersededKeyEnvVarPrefix is the pre-rename spelling, still honoured with a
// deprecation warning -- see internal/envcompat.
const SupersededKeyEnvVarPrefix = "VCE_AI_KEY_"

// KeyEnvVar returns the environment variable that overrides the stored value
// for entry: the entry id upper-cased with every character that isn't ASCII
// alphanumeric replaced by an underscore, prefixed by KeyEnvVarPrefix. So the
// "anthropic" provider key is CIRCLECI_EDITOR_AI_KEY_ANTHROPIC.
//
// The rule is mechanical rather than a lookup table so a provider added later
// needs no change here, and so the name a user must type is derivable from the
// provider id they already see in `ai status` output.
func KeyEnvVar(entry string) string {
	return KeyEnvVarPrefix + strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z':
			return r - ('a' - 'A')
		case r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return r
		default:
			return '_'
		}
	}, entry)
}

// envKeyIsSet reports whether KeyEnvVar(entry) is set to a non-empty value,
// without returning it. Kept separate from envKey so the presence check --
// which is all any status or provenance path needs -- cannot accidentally
// carry the value with it.
func envKeyIsSet(entry string) bool {
	return strings.TrimSpace(envValue(entry)) != ""
}

// envValue reads entry's key from the current variable name, falling back to
// the superseded VCE_ spelling with a one-time deprecation warning. Both the
// presence check and the read go through here so they can never disagree about
// whether a key is set -- the precedence rule this package exists to own.
func envValue(entry string) string {
	return envcompat.Value(KeyEnvVar(entry), supersededKeyEnvVar(entry))
}

// effectiveKeyEnvVar names the variable that is actually supplying entry's key,
// falling back to the current spelling when neither is set -- so a status line
// can say where a key really came from instead of where it should have.
func effectiveKeyEnvVar(entry string) string {
	if os.Getenv(KeyEnvVar(entry)) == "" && os.Getenv(supersededKeyEnvVar(entry)) != "" {
		return supersededKeyEnvVar(entry)
	}
	return KeyEnvVar(entry)
}

// supersededKeyEnvVar is KeyEnvVar's pre-rename spelling for the same entry.
func supersededKeyEnvVar(entry string) string {
	return SupersededKeyEnvVarPrefix + strings.TrimPrefix(KeyEnvVar(entry), KeyEnvVarPrefix)
}

// envKey reads entry's value from the environment, wrapped in secret.String
// from the moment it leaves os.Getenv so no plain string of it exists outside
// this function. Surrounding whitespace is trimmed: a shell export or a `read`
// loop routinely leaves a trailing newline, and no provider key has meaningful
// leading or trailing space.
func envKey(entry string) (secret.String, bool) {
	value := strings.TrimSpace(envValue(entry))
	if value == "" {
		return secret.String{}, false
	}
	return secret.New(value), true
}

// WithEnvOverride wraps store so that a key present in the environment (see
// KeyEnvVar) wins over anything stored. Open applies this to every Store it
// returns, which is what makes the precedence rule a single fact about this
// package rather than something each caller -- the CLI's `ai` commands, the
// host's chat and status handlers -- has to remember to implement the same
// way.
//
// Writes are deliberately *not* intercepted: Set still writes to the
// underlying store and Delete still removes from it, because this process
// cannot change the environment of the shell that will run the next one.
// That leaves one honest wrinkle -- a stored key can be shadowed by a
// variable, so `ai set-key` and `ai remove-key` say so when the variable is
// set (see cmd/circleci-editor/ai.go) rather than reporting a change
// that will have no effect.
func WithEnvOverride(store Store) Store { return envOverride{inner: store} }

// envOverride is WithEnvOverride's Store: environment first on reads,
// pass-through on writes.
type envOverride struct{ inner Store }

func (e envOverride) Get(ctx context.Context, entry string) (secret.String, bool, error) {
	if key, ok := envKey(entry); ok {
		return key, true, nil
	}
	return e.inner.Get(ctx, entry)
}

func (e envOverride) Set(ctx context.Context, entry string, key secret.String) error {
	return e.inner.Set(ctx, entry, key)
}

func (e envOverride) Delete(ctx context.Context, entry string) error {
	return e.inner.Delete(ctx, entry)
}

func (e envOverride) Backend() Backend { return e.inner.Backend() }

func (e envOverride) Location() string { return e.inner.Location() }

// withoutEnvOverride exposes the wrapped store, so a caller that specifically
// needs to know what is *stored* (as opposed to what is in effect) can ask --
// see LookupKey, which has to distinguish "stored" from "shadowed by a
// variable" to explain precedence to a user.
func (e envOverride) withoutEnvOverride() Store { return e.inner }

// storeWithoutEnvOverride returns store's underlying store if it is an
// environment overlay, or store itself otherwise. Written against an
// anonymous interface rather than a type assertion to envOverride so a future
// second wrapper can opt in by implementing the same method.
func storeWithoutEnvOverride(store Store) Store {
	if u, ok := store.(interface{ withoutEnvOverride() Store }); ok {
		return u.withoutEnvOverride()
	}
	return store
}

// KeySource identifies where the key in effect for one entry comes from.
type KeySource string

// The three provenances LookupKey can report.
const (
	// SourceEnv means an environment variable supplies the key, and it wins
	// over anything stored.
	SourceEnv KeySource = "environment"
	// SourceStore means the key comes from the keychain or the file store.
	SourceStore KeySource = "store"
	// SourceNone means no key is configured at all.
	SourceNone KeySource = "none"
)

// Lookup answers "is a key configured for this entry, and where does it come
// from" -- and, by construction, nothing else: it has no field capable of
// holding a key, not even a truncated prefix of one, so no caller built on it
// can print, log, or return the value by accident. That is the whole reason
// this type exists instead of callers using Store.Get and inspecting what
// comes back.
type Lookup struct {
	// Source is the provenance of the key that would be used right now.
	Source KeySource
	// EnvVar is the environment variable a message should name for this
	// entry. Always populated, whether or not anything is set.
	//
	// When a key is actually being supplied by the superseded VCE_ spelling,
	// this is that spelling rather than the current one -- naming a variable
	// the user has not set, while a different one is doing the work, is the
	// kind of confidently wrong report this package exists to avoid. With
	// nothing set it is the current name, which is the one worth telling
	// someone to use.
	EnvVar string
	// EnvSet reports whether EnvVar is set to a non-empty value.
	EnvSet bool
	// Stored reports whether the underlying store holds a key, independent
	// of EnvSet -- when both are true the stored key is shadowed, which is
	// the case a user debugging "why is it using the wrong key" needs to
	// see.
	Stored bool
	// StoreErr is a genuine failure to read the store (a corrupt file, a
	// misbehaving keychain tool), not "nothing stored". Reported alongside
	// the rest rather than replacing it: when EnvSet is true, a key is still
	// in effect regardless of the store being unreadable, and saying so is
	// more useful than failing.
	StoreErr error
}

// LookupKey reports which key is in effect for entry, and where it comes
// from, without ever handling the value itself (see Lookup). store may be
// either the environment-wrapped Store that Open returns or a bare backend;
// either way what is *stored* is read from the underlying backend, so a set
// variable can never be mistaken for a stored key.
func LookupKey(ctx context.Context, store Store, entry string) Lookup {
	result := Lookup{
		Source: SourceNone,
		EnvVar: effectiveKeyEnvVar(entry),
		EnvSet: envKeyIsSet(entry),
	}

	_, stored, err := storeWithoutEnvOverride(store).Get(ctx, entry)
	result.Stored = stored
	result.StoreErr = err

	switch {
	case result.EnvSet:
		result.Source = SourceEnv
	case stored:
		result.Source = SourceStore
	}
	return result
}

// Ensure envOverride satisfies Store at compile time.
var _ Store = envOverride{}
