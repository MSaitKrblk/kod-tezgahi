# Kod Tezgâhı

Tarayıcıdan kullanılan kod araçları: kayıtlı kod panosu, JSON/XML biçimlendirme, HTML/CSS/JS/SQL güzelleştirme, JSON/XML ağaç görünümü, JSON/XML/metin karşılaştırma, Base64/URL, JWT ve hash.

Biçimlendirme ve karşılaştırma tarayıcıda yapılır. Sunucu yalnızca sayfayı sunar ve Pano kayıtlarını `DATA_DIR/snippets.json` dosyasında saklar. Her istek HTTP Basic auth ile korunur (`/healthz` hariç).

## Ortam değişkenleri

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `APP_PASSWORD` | yok (zorunlu) | Giriş parolası. Tanımlı değilse sunucu başlamaz. |
| `APP_USER` | `admin` | Giriş kullanıcı adı. |
| `PORT` | `3000` | Dinlenen port. |
| `DATA_DIR` | `/data` (Docker) | Pano kayıtlarının tutulduğu klasör. Kalıcı bir volume bağla. |
| `AUTH_DISABLED` | — | `1` verilirse giriş kapanır. Yalnızca yerel deneme için. |

## Yerelde çalıştırma

```bash
npm ci
AUTH_DISABLED=1 DATA_DIR=./data node server.js
```

## Coolify

Public Repository → Build Pack: Docker Compose (`/docker-compose.yml`). Coolify `APP_PASSWORD` için `SERVICE_PASSWORD_APP` değerini kendisi üretir; `/data` adlandırılmış bir volume'de kalır. `app` servisine domain'i iç port 3000 ile ver (`https://alan.adi:3000`).
