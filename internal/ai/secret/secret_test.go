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

package secret_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
)

const sentinel = "sk-ant-super-secret-value-should-never-appear"

func TestString_New_IsSet(t *testing.T) {
	assert.Equal(t, secret.New(sentinel).IsSet(), true)
	assert.Equal(t, secret.New("").IsSet(), false)
	assert.Equal(t, secret.String{}.IsSet(), false)
}

func TestString_Reveal_ReturnsTheRealValue(t *testing.T) {
	assert.Equal(t, secret.New(sentinel).Reveal(), sentinel)
	assert.Equal(t, secret.New("").Reveal(), "")
}

func TestString_Fn_NeverPrintsTheRealValue(t *testing.T) {
	s := secret.New(sentinel)

	for _, format := range []string{"%s", "%v", "%+v", "%#v", "%q"} {
		out := fmt.Sprintf(format, s)
		assert.Assert(t, !strings.Contains(out, sentinel), "format %q leaked the secret: %s", format, out)
	}
}

func TestString_Fn_UnsetPrintsEmpty(t *testing.T) {
	assert.Equal(t, secret.String{}.String(), "")
}

func TestString_Fn_MarshalJSON_NeverEncodesTheRealValue(t *testing.T) {
	type wrapper struct {
		Key secret.String `json:"key"`
	}

	out, err := json.Marshal(wrapper{Key: secret.New(sentinel)})
	assert.NilError(t, err)
	assert.Assert(t, !strings.Contains(string(out), sentinel), "JSON leaked the secret: %s", out)
	assert.Equal(t, string(out), `{"key":"[REDACTED]"}`)
}

func TestString_Fn_MarshalJSON_UnsetEncodesEmptyString(t *testing.T) {
	out, err := json.Marshal(secret.String{})
	assert.NilError(t, err)
	assert.Equal(t, string(out), `""`)
}

func TestString_Fn_UnmarshalJSON_DecodesTheRealValue(t *testing.T) {
	type wrapper struct {
		Key secret.String `json:"key"`
	}

	var got wrapper
	err := json.Unmarshal([]byte(`{"key":"`+sentinel+`"}`), &got)
	assert.NilError(t, err)
	assert.Equal(t, got.Key.IsSet(), true)
	assert.Equal(t, got.Key.Reveal(), sentinel)
	// Decoded, it is still unprintable -- which is the entire point of being
	// able to decode into this type rather than into a plain string.
	assert.Equal(t, got.Key.String(), redactedForTest)
	assert.Assert(t, !strings.Contains(fmt.Sprintf("%+v", got), sentinel))
}

// Marshal and Unmarshal are deliberately *not* inverses: encoding destroys the
// value. A round trip must therefore lose it rather than quietly preserving it,
// because "it survived a round trip" would mean some path can re-emit it.
func TestString_Fn_MarshalThenUnmarshalDoesNotRoundTrip(t *testing.T) {
	encoded, err := json.Marshal(secret.New(sentinel))
	assert.NilError(t, err)

	var back secret.String
	assert.NilError(t, json.Unmarshal(encoded, &back))
	assert.Assert(t, back.Reveal() != sentinel)
	assert.Equal(t, back.Reveal(), redactedForTest)
}

func TestString_Fn_UnmarshalJSON_NullAndEmptyAreUnset(t *testing.T) {
	var s secret.String
	assert.NilError(t, json.Unmarshal([]byte(`null`), &s))
	assert.Equal(t, s.IsSet(), false)

	assert.NilError(t, json.Unmarshal([]byte(`""`), &s))
	assert.Equal(t, s.IsSet(), false)
}

// A malformed value must not be quoted back: for this type the malformed input
// is the secret, and encoding/json's own type errors can include it.
func TestString_Fn_UnmarshalJSON_ErrorNeverQuotesTheInput(t *testing.T) {
	var s secret.String
	err := json.Unmarshal([]byte(`{"nested":"`+sentinel+`"}`), &s)
	assert.Assert(t, err != nil)
	assert.Assert(t, !strings.Contains(err.Error(), sentinel), "error leaked the input: %v", err)
}

// redactedForTest mirrors the package's unexported `redacted` constant. Spelled
// out here rather than exported so the placeholder stays an implementation
// detail of the package while still being assertable.
const redactedForTest = "[REDACTED]"
