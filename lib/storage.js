import crypto from 'crypto';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

// Cloudflare R2 يتعامل مع واجهة S3، لذلك نستخدم مكتبة AWS الرسمية
const REQUIRED = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL'];
const enabled = REQUIRED.every((key) => process.env[key]);
const IS_PROD = process.env.NODE_ENV === 'production';
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');

const client = enabled
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

export const storageEnabled = enabled;

const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/**
 * يرفع صورة (data URL) إلى R2 ويعيد رابطها العام.
 * القيمة الفارغة تعيد null.
 */
export async function storeImage(dataUrl, folder) {
  if (!dataUrl) return null;
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error('صيغة الصورة غير صالحة');

  if (!client) {
    // وضع التطوير فقط: تبقى الصورة داخل قاعدة البيانات
    if (IS_PROD) throw new Error('التخزين السحابي غير مهيأ');
    return dataUrl;
  }

  const [, type, base64] = match;
  const ext = type === 'jpeg' ? 'jpg' : type;
  const key = `${folder}/${crypto.randomUUID()}.${ext}`;

  await client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: Buffer.from(base64, 'base64'),
      ContentType: MIME[type],
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );
  return `${PUBLIC_URL}/${key}`;
}

// يحذف الصورة من R2 إن كانت من مخزننا، ولا يوقف العملية عند الفشل
export async function removeImage(url) {
  if (!client || !url || !url.startsWith(`${PUBLIC_URL}/`)) return;
  const key = url.slice(PUBLIC_URL.length + 1);
  try {
    await client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
  } catch (err) {
    console.error('تعذر حذف الصورة:', key, err.message);
  }
}
