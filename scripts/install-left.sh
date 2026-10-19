#!/data/data/com.termux/files/usr/bin/bash
set -eu
directory=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source="$directory/left.py"
: "${PREFIX:?PREFIX must be set}"
chmod +x -- "$source"
mkdir -p -- "$PREFIX/bin"
for name in left Left 사용량; do
    destination="$PREFIX/bin/$name"
    if [ -L "$destination" ] && [ "$(readlink -- "$destination")" = "$source" ]; then
        continue
    fi
    ln -sT -- "$source" "$destination"
done
