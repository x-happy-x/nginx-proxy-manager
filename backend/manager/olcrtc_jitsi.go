package main

import (
	_ "embed"
	"fmt"
)

// Keep the wire-compatible olcrtc commit; only its Jitsi HTTP reader changes.
const olcBuildVersion = "92b2332-jitsi-config-v1"

//go:embed olcrtc_jitsi.patch
var olcJitsiPatch string

func olcServerBuildScript() string {
	return fmt.Sprintf(`cd %[1]s/src || exit 1
h=%[2]s
if [ -x %[1]s/olcrtc ] && [ "$(cat %[1]s/.built 2>/dev/null)" = "$h" ]; then
  echo "уже собран из этой версии $h"
else
  a=$(df -Pm / | awk 'NR==2{print $4}')
  [ "$a" -ge 2500 ] || { echo "на диске $a МБ, для сборки нужно 2500" >&2; exit 1; }
  /usr/local/go/bin/go mod download github.com/zarazaex69/j@v0.0.1 &&
  src=$(/usr/local/go/bin/go env GOMODCACHE)/github.com/zarazaex69/j@v0.0.1 &&
  mkdir -p .homenet-jitsi && cp -R "$src/." .homenet-jitsi/ && chmod -R u+w .homenet-jitsi &&
  patch --batch -d .homenet-jitsi -p1 <<'HOMENET_JITSI_PATCH' &&
%[3]sHOMENET_JITSI_PATCH
  /usr/local/go/bin/go mod edit -replace github.com/zarazaex69/j=./.homenet-jitsi &&
  CGO_ENABLED=0 GOFLAGS=-buildvcs=false /usr/local/go/bin/go build -trimpath -ldflags "-s -w" -o %[1]s/olcrtc.new ./cmd/olcrtc &&
  mv %[1]s/olcrtc.new %[1]s/olcrtc && echo "$h" > %[1]s/.built && echo "собран $h"
fi
rc=$?; /usr/local/go/bin/go clean -cache -modcache >/dev/null 2>&1; exit $rc`, olcDir, olcBuildVersion, olcJitsiPatch)
}
