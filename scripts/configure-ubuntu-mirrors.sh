#!/bin/sh
# Keep Ubuntu's suites, components and signing keys. APT retries individual
# index and package downloads on the next mirror if the first one fails.
set -eu
apt_dir=${1:-/etc/apt}
archive_list="$apt_dir/ua-ubuntu-mirrors.txt"
runner_list="$apt_dir/apt-mirrors.txt"
security_list="$apt_dir/apt-security-mirrors.txt"
if [ -s "$runner_list" ]; then
    # A hosted runner can already reference this list directly. Preserve all
    # existing mirrors, adding a fallback only for Ubuntu archive/security lists.
    if grep -Eq 'https?://((azure\.)?archive|security)\.ubuntu\.com/ubuntu(/|[[:space:]]|$)' "$runner_list" &&
       ! grep -Fq 'https://mirrors.edge.kernel.org/ubuntu' "$runner_list"; then
        printf '\n%s\tpriority:2\n' 'https://mirrors.edge.kernel.org/ubuntu' >> "$runner_list"
    fi
fi

write_mirrors() {
    printf '%s\tpriority:1\n%s\tpriority:2\n' "$1" 'https://mirrors.edge.kernel.org/ubuntu' > "$2"
}
write_mirrors 'https://archive.ubuntu.com/ubuntu' "$archive_list"
write_mirrors 'https://security.ubuntu.com/ubuntu' "$security_list"

for source in "$apt_dir/sources.list" "$apt_dir"/sources.list.d/*.list "$apt_dir"/sources.list.d/*.sources; do
    [ -f "$source" ] || continue
    sed -E -i \
        -e "s#https?://(azure\\.)?archive\\.ubuntu\\.com/ubuntu/?([[:space:]]|$)#mirror+file:$archive_list\\2#g" \
        -e "s#https?://security\\.ubuntu\\.com/ubuntu/?([[:space:]]|$)#mirror+file:$security_list\\1#g" \
        "$source"
done
