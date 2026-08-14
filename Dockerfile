# ═══════════════════════════════════════════════════════════════════
# Multi-stage build -- stage "builder" install semua dependency +
# jalanin obfuscation (scripts/build-obfuscate.js), stage "runtime"
# CUMA copy HASIL build (dist/) + install ulang dependency production
# doang. Efeknya:
#   - Image FINAL gak pernah punya source .js yang mudah dibaca --
#     yang ke-bundle cuma hasil obfuscate.
#   - devDependencies (javascript-obfuscator, nodemon) gak ikut ke
#     image final -- lebih kecil & gak ada tool buat "bantu" bongkar.
#   - licensing-tools/ TIDAK PERNAH masuk sini sama sekali (lihat
#     .dockerignore) -- private key gak mungkin ke-bundle walau
#     kelupaan ada di folder project pas build.
# ═══════════════════════════════════════════════════════════════════

FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/dist/package.json /app/dist/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist/ ./
RUN mkdir -p uploads/bukti

# license.lic SENGAJA GAK di-COPY ke image -- itu di-mount lewat volume
# pas `docker run`/`docker-compose up` (beda per customer, beda per
# instalasi, gak boleh ke-bake ke dalam image yang sama buat semua orang).

EXPOSE 3010

# Migrasi DB OTOMATIS dulu (bikin skema+tabel kalau DB masih kosong,
# SKIP kalau udah pernah -- lihat scripts/migrate.js, idempotent by
# design), baru start servernya. Customer gak perlu jalanin
# `mysql -u root -p < schema.sql` manual sama sekali.
CMD ["sh", "-c", "node scripts/migrate.js && node server.js"]
