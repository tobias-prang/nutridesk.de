#!/bin/sh
set -eu

APP_DIR=/home/nutridesk.de/app
ENV_FILE="$APP_DIR/server/.env"
CREDENTIAL_FILE=/root/.nutridesk-noreply-credentials
EXIM_UPDATE=/etc/exim4/update-exim4.conf.conf

if [ "$(id -u)" -ne 0 ]; then
  echo "Dieses Skript muss als root laufen." >&2
  exit 1
fi

stamp=$(date +%Y%m%d-%H%M%S)
cp -a "$EXIM_UPDATE" "$EXIM_UPDATE.bak-$stamp"

if ! id noreply >/dev/null 2>&1; then
  adduser --system --group --home /var/lib/nutridesk-mail --shell /usr/sbin/nologin noreply
fi
install -d -o noreply -g noreply -m 0700 /var/lib/nutridesk-mail

if [ -s "$CREDENTIAL_FILE" ]; then
  smtp_password=$(sed -n 's/^SMTP_PASSWORD=//p' "$CREDENTIAL_FILE" | head -n 1)
else
  smtp_password=$(openssl rand -hex 24)
  umask 077
  printf '%s\n' 'SMTP_USER=noreply@nutridesk.de' "SMTP_PASSWORD=$smtp_password" > "$CREDENTIAL_FILE"
  chmod 0600 "$CREDENTIAL_FILE"
fi
test -n "$smtp_password"

smtp_hash=$(printf '%s' "$smtp_password" | openssl passwd -6 -stdin)
umask 077
printf '%s:%s\n' 'noreply@nutridesk.de' "$smtp_hash" > /etc/exim4/passwd
chown root:Debian-exim /etc/exim4/passwd
chmod 0640 /etc/exim4/passwd

sed -i \
  -e "s/^dc_eximconfig_configtype=.*/dc_eximconfig_configtype='internet'/" \
  -e "s/^dc_other_hostnames=.*/dc_other_hostnames='nutridesk.de ; vmd197921.contaboserver.net'/" \
  -e "s/^dc_local_interfaces=.*/dc_local_interfaces='127.0.0.1 ; ::1'/" \
  -e "s/^dc_use_split_config=.*/dc_use_split_config='true'/" \
  "$EXIM_UPDATE"

install -o root -g root -m 0644 "$APP_DIR/ops/exim/00_nutridesk_local_settings" /etc/exim4/conf.d/main/00_nutridesk_local_settings
install -o root -g root -m 0644 "$APP_DIR/ops/exim/30_nutridesk_passwd_auth" /etc/exim4/conf.d/auth/30_nutridesk_passwd_auth

update-exim4.conf
exim4 -bV >/dev/null
systemctl enable --now exim4

# Die App-Daten werden bereits vorbereitet. SMTP_DELIVERY_ENABLED bleibt
# bewusst 0, solange der Hoster ausgehendes SMTP blockiert und kein Relay
# hinterlegt ist; dadurch werden keine Zugangsdaten nur scheinbar versendet.
for key in SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASS MAIL_FROM SMTP_DELIVERY_ENABLED; do
  sed -i "/^${key}=/d" "$ENV_FILE"
done
{
  printf '%s\n' 'SMTP_HOST=127.0.0.1'
  printf '%s\n' 'SMTP_PORT=587'
  printf '%s\n' 'SMTP_SECURE=0'
  printf '%s\n' 'SMTP_USER=noreply@nutridesk.de'
  printf '%s\n' "SMTP_PASS=$smtp_password"
  printf '%s\n' 'MAIL_FROM="NutriDesk <noreply@nutridesk.de>"'
  printf '%s\n' 'SMTP_DELIVERY_ENABLED=0'
} >> "$ENV_FILE"
chmod 0600 "$ENV_FILE"

pm2 restart nutridesk.de --update-env >/dev/null
pm2 save >/dev/null

echo "noreply@nutridesk.de wurde lokal angelegt. Zugangsdaten: $CREDENTIAL_FILE"
