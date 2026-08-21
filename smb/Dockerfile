FROM node:22-bookworm-slim

RUN apt-get update \
 # samba-vfs-modules traz catia/fruit/streams_xattr; sem ele o smbd recusa cada
 # conexão com "vfs_init failed", porque o provisionador declara esses módulos.
 && apt-get install -y --no-install-recommends samba samba-common-bin samba-vfs-modules rclone fuse3 procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# O rclone precisa que outros usuários enxerguem o mount para o smbd servir os arquivos.
RUN echo "user_allow_other" >> /etc/fuse.conf

WORKDIR /app
COPY smb/provisioner.js ./provisioner.js
COPY smb/smb.conf.base ./smb.conf.base
COPY smb/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

RUN mkdir -p /mnt/omnicloud /var/cache/rclone /var/log/samba

EXPOSE 445
CMD ["./entrypoint.sh"]
