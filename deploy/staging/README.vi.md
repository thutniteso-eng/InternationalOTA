# Hướng dẫn vận hành môi trường Staging (WSL + Docker + Cloudflare Quick Tunnel)

Môi trường staging chạy hoàn toàn trên máy WSL với Docker, được public tạm thời qua Cloudflare Quick Tunnel (`https://<ngẫu-nhiên>.trycloudflare.com`) và bảo vệ bằng Basic Auth ở reverse proxy Caddy.

> Lưu ý quan trọng:
>
> - Địa chỉ `https://*.trycloudflare.com` thay đổi **mỗi lần khởi động lại**.
> - Tập tin bí mật `deploy/staging/.env.staging` được tự động tạo ở lần chạy đầu tiên (quyền `600`, đã được `.gitignore` bỏ qua). **Không bao giờ commit tập tin này lên Git.**

---

## 1. Khởi động Staging

```bash
./scripts/staging-up.sh
```

Lệnh này sẽ tự động:

1. Tạo `deploy/staging/.env.staging` với mật khẩu và khóa ngẫu nhiên nếu chưa có.
2. Khởi chạy `cloudflared` và lấy URL `https://….trycloudflare.com` vừa được cấp.
3. Cập nhật `PUBLIC_BASE_URL`, `BETTER_AUTH_URL` và `AUTH_TRUSTED_ORIGINS`.
4. Build Docker image cho `api` và `web`, khởi động `postgres`, chạy migration + seed dữ liệu chuẩn + thiết lập quyền `ota_app` thông qua `ota_owner`.
5. Khởi chạy `api`, `web` và `caddy`, rồi in ra URL public cùng tên đăng nhập Basic Auth (`staging`).

Xem mật khẩu Basic Auth khi cần truy cập trình duyệt hoặc `curl`:

```bash
grep '^STAGING_BASIC_AUTH_' deploy/staging/.env.staging
```

---

## 2. Dừng Staging (giữ nguyên dữ liệu)

```bash
./scripts/staging-down.sh
```

Các container sẽ dừng lại nhưng volume dữ liệu PostgreSQL (`staging_postgres_data`) và cấu hình trong `deploy/staging/.env.staging` vẫn được giữ nguyên. Khi chạy lại `./scripts/staging-up.sh`, URL tunnel sẽ mới nhưng toàn bộ dữ liệu tài khoản và sổ cái vẫn còn.

---

## 3. Sao lưu cơ sở dữ liệu (Backup)

```bash
./scripts/staging-backup.sh
```

- Tạo bản sao lưu định dạng custom (`pg_dump --format=custom`) lưu tại `~/ota-backups/ota_staging_<YYYYMMDDTHHMMSSZ>.dump` (nằm ngoài thư mục repo).
- Tự động chỉ giữ lại **7 bản sao lưu gần nhất**.

---

## 4. Khôi phục cơ sở dữ liệu (Restore)

### Khôi phục sang một database mới để kiểm tra (an toàn, không ghi đè database đang chạy):

```bash
./scripts/staging-restore.sh ~/ota-backups/ota_staging_<TIMESTAMP>.dump
```

Script sẽ tạo một database mới `ota_restore_<TIMESTAMP>`, khôi phục dữ liệu vào đó và in bảng so sánh số dòng giữa database live và database vừa restore.

### Khôi phục đè lên database live (chỉ dùng khi thực sự cần phục hồi sự cố):

```bash
./scripts/staging-restore.sh ~/ota-backups/ota_staging_<TIMESTAMP>.dump --replace
```

Cờ `--replace` bắt buộc phải truyền tường minh thì script mới dừng API, thay thế database live `ota_staging`, chạy lại phân quyền `ota_app` và khởi động lại dịch vụ.
