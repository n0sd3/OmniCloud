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

# `wait -n` é bashism; /bin/sh do Debian é dash. Poll portátil que sai assim que
# qualquer um dos dois filhos morre, para o Docker reiniciar o container.
while kill -0 "$SMBD_PID" 2>/dev/null && kill -0 "$PROVISIONER_PID" 2>/dev/null; do
	sleep 5
done

kill "$SMBD_PID" "$PROVISIONER_PID" 2>/dev/null
exit 1
