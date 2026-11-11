#!/bin/sh
# Keep Ubuntu's suites, components and signing keys. APT retries individual
# index and package downloads on the next mirror if the first one fails.
set -eu
apt_dir=${1:-/etc/apt}
archive_list="$apt_dir/ua-ubuntu-mirrors.txt"
runner_list="$apt_dir/apt-mirrors.txt"
security_list="$apt_dir/apt-security-mirrors.txt"
# Hosted Ubuntu runners have experienced long DNS outages for both Ubuntu
# domains. APT selects a mirror per file, so prefer the working independent
# mirror instead of repeating a DNS timeout for every index and package.
preferred='https://mirrors.edge.kernel.org/ubuntu'
if [ -s "$runner_list" ] &&
   grep -Eq 'https?://((azure\.)?archive|security)\.ubuntu\.com/ubuntu(/|[[:space:]]|$)' "$runner_list" &&
   ! grep -Fxq "$(printf '%s\tpriority:0' "$preferred")" "$runner_list"; then
    # Preserve runner/custom mirrors and comments. Replace only our own entry.
    sed -i '\#^https://mirrors\.edge\.kernel\.org/ubuntu/\?\([[:space:]].*\)\?$#d' "$runner_list"
    printf '\n%s\tpriority:0\n' "$preferred" >> "$runner_list"
fi

write_mirrors() {
    printf '%s\tpriority:0\n%s\tpriority:2\n' "$preferred" "$1" > "$2"
}
write_mirrors 'https://archive.ubuntu.com/ubuntu' "$archive_list"
write_mirrors 'https://security.ubuntu.com/ubuntu' "$security_list"

# Playwright invokes apt-get itself and otherwise downloads translation
# indexes even though the browser and document packages only need metadata.
mkdir -p "$apt_dir/apt.conf.d"
printf '%s\n' 'Acquire::Languages "none";' > "$apt_dir/apt.conf.d/80-unfallatlas-ci-languages"

for source in "$apt_dir/sources.list" "$apt_dir"/sources.list.d/*.list "$apt_dir"/sources.list.d/*.sources; do
    [ -f "$source" ] || continue
    sed -E -i \
        -e "s#https?://(azure\\.)?archive\\.ubuntu\\.com/ubuntu/?([[:space:]]|$)#mirror+file:$archive_list\\2#g" \
        -e "s#https?://security\\.ubuntu\\.com/ubuntu/?([[:space:]]|$)#mirror+file:$security_list\\1#g" \
        "$source"
done
