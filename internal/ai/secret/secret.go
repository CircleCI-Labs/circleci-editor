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

// Package secret provides a small wrapper type for values -- provider API
// keys, in this codebase -- that must never be accidentally logged, printed,
// or serialized. It mirrors the shape of CircleCI's own internal
// `secret.String` convention: a value that prints and marshals as a redacted
// placeholder everywhere by default, with exactly one explicit escape hatch
// (Reveal) for the few call sites that legitimately need the real value (here:
// the outgoing HTTP request to a provider, and nowhere else).
//
// This exists because issue #92's security review found the natural failure
// mode for a bring-your-own-key feature: an API key that flows through a
// plain `string` is one `log.Printf("%+v", req)` or one careless response
// struct away from being written to a log file or echoed back to the
// browser. Routing every key through String from the moment it is read out
// of the keystore (see internal/ai/keystore) makes that mistake require
// deliberately calling Reveal, rather than requiring deliberate care not to.
package secret

import (
	"encoding/json"
	"errors"
)

// redacted is what every printing/serialization path returns for a set
// value. It deliberately does not reveal even the value's length -- an
// observed length can narrow a brute-force search space for a short key.
const redacted = "[REDACTED]"

// String holds a sensitive string value. The zero value is unset (IsSet
// reports false) and behaves identically to a set empty string everywhere
// except IsSet, which is the intended way to test "was a key configured at
// all" without comparing against "".
type String struct {
	value string
	set   bool
}

// New wraps value as a String. An empty value is treated as unset (IsSet
// returns false), matching how an absent provider key and an empty one are
// the same "not configured" state everywhere else in this package.
func New(value string) String {
	return String{value: value, set: value != ""}
}

// IsSet reports whether this String holds a non-empty value.
func (s String) IsSet() bool {
	return s.set
}

// String implements fmt.Stringer. It never returns the wrapped value: every
// %s/%v verb, every string concatenation, and every accidental
// fmt.Println(key) prints the same redacted placeholder instead of the
// secret.
func (s String) String() string {
	if !s.set {
		return ""
	}
	return redacted
}

// GoString implements fmt.GoStringer, so the %#v verb (commonly used in
// panic/error dumps and test failure output) is exactly as safe as %v.
func (s String) GoString() string {
	return s.String()
}

// MarshalJSON implements json.Marshaler. Encoding a String -- whether
// deliberately or because it was embedded in a larger struct passed to
// json.Marshal by mistake -- always produces the redacted placeholder (or
// an empty string when unset), never the real value. This is what makes it
// safe for a handler to accept a request struct containing a String field
// without a separate audit that nothing downstream re-serializes it into a
// response.
func (s String) MarshalJSON() ([]byte, error) {
	return json.Marshal(s.String())
}

// UnmarshalJSON implements json.Unmarshaler, so a String can be the declared
// type of a field that a *response* is decoded into -- and therefore the
// declared type of anything holding a credential that arrived over the wire,
// not just one on its way out.
//
// This is the asymmetry that makes the type useful in both directions.
// MarshalJSON deliberately destroys the value (redaction is the whole point),
// so this is not its inverse and the two do not round-trip -- by design: a
// value decoded from a token response can be used and re-sent, but it cannot
// be re-serialized into anything a log or an HTTP response would carry.
//
// The motivating case is internal/ai/mcpauth's OAuth token responses. Without
// this, the only way to decode `{"access_token": "..."}` is into a plain
// `string` field, which is exactly the accident this package exists to
// prevent -- and which gosec's G117 correctly flags as "an exported struct
// field whose JSON key matches a secret pattern". Making String decodable
// means the wire struct can name the sensitive fields as secrets from the
// moment they are parsed, with no window in which they exist as a printable
// string.
//
// A JSON null decodes to unset, matching New("")'s treatment of empty.
func (s *String) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		*s = String{}
		return nil
	}
	var raw string
	if err := json.Unmarshal(data, &raw); err != nil {
		// Deliberately does not wrap err: encoding/json's type errors can
		// quote the offending input, and for this type the input is the
		// secret. The field's name is not worth the risk either -- a caller
		// that got here has a malformed response, not a mystery.
		return errors.New("secret: value is not a JSON string")
	}
	*s = New(raw)
	return nil
}

// Reveal returns the wrapped value. Every call site in this codebase must
// justify in a comment why it needs the real value; as of this writing those
// are: the outgoing HTTP request built in internal/ai/anthropic (and any
// future provider package) to authenticate with the provider's API, and
// internal/ai/mcpauth's OAuth form bodies and keystore persistence path.
// Never pass the result of Reveal to a logger, an error, or an HTTP response.
func (s String) Reveal() string {
	return s.value
}
