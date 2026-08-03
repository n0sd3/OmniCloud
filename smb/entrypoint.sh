#!/bin/sh
set -e

cp /app/smb.conf.base /etc/samba/smb.conf

# smbd em foreground como processo filho; o provisionador recarrega a config
# via smbcontrol conforme os usuários mudam.
smbd --foreground --no-process-group --debug-stdout &
SMBD_PID=$!

node /app/provisioner.js &
PROVISIONER_PID=$!

trap 'kill $SMBD_PID $PROVISIONER_PID 2>/dev/null; exit 0' TERM INT

wait -n $SMBD_PID $PROVISIONER_PID
