#!/bin/sh
set -eu

stamp=$(date +%Y%m%d-%H%M%S)
macro_file=/etc/exim4/exim4.conf.localmacros
split_macro_file=/etc/exim4/conf.d/main/000_localmacros
dkim_dir=/etc/exim4/dkim
hubbed_hosts=/etc/exim4/hubbed_hosts

if [ -f "$macro_file" ]; then
  cp -a "$macro_file" "$macro_file.bak-$stamp"
fi
install -d -o root -g Debian-exim -m 0750 "$dkim_dir"
if [ ! -s "$dkim_dir/nutridesk.de.key" ]; then
  openssl genrsa -out "$dkim_dir/nutridesk.de.key" 2048 >/dev/null 2>&1
fi
chown root:Debian-exim "$dkim_dir/nutridesk.de.key"
chmod 0640 "$dkim_dir/nutridesk.de.key"

cat > "$macro_file" <<'EOF'
DKIM_DOMAIN = nutridesk.de
DKIM_SELECTOR = nd20260925
DKIM_PRIVATE_KEY = /etc/exim4/dkim/nutridesk.de.key
DKIM_CANON = relaxed
DKIM_STRICT = 0
EOF
chmod 0644 "$macro_file"

cat > "$split_macro_file" <<'EOF'
disable_ipv6 = true
DKIM_DOMAIN = nutridesk.de
DKIM_SELECTOR = nd20260925
DKIM_PRIVATE_KEY = /etc/exim4/dkim/nutridesk.de.key
DKIM_CANON = relaxed
DKIM_STRICT = 0
EOF
chmod 0644 "$split_macro_file"

# Gmail's primary MX can retain stale reverse-DNS data for several hours after
# a PTR correction. alt1 is an official Gmail MX and already validates the
# current forward/reverse DNS pair, so route Gmail there deterministically.
printf '%s\n' 'gmail.com: alt1.gmail-smtp-in.l.google.com' > "$hubbed_hosts"
chmod 0644 "$hubbed_hosts"

update-exim4.conf
exim4 -bV >/dev/null
systemctl restart exim4

openssl rsa -in "$dkim_dir/nutridesk.de.key" -pubout 2>/dev/null \
  | sed '1d;$d' | tr -d '\n'
printf '\n'
