import nodemailer from 'nodemailer';

const port = Number(process.env.SMTP_PORT) || 587;

const transport = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    })
  : null;

const SUBJECTS = {
  verify: 'رمز تأكيد البريد الإلكتروني | Email verification code',
  reset: 'رمز استعادة كلمة المرور | Password reset code',
};

export async function sendCode(to, code, purpose) {
  const text =
    `رمزك: ${code}\nصالح لمدة 15 دقيقة. إن لم تطلب هذا الرمز فتجاهل الرسالة.\n\n` +
    `Your code: ${code}\nValid for 15 minutes. If you did not request it, ignore this email.`;

  if (!transport) {
    // في التطوير فقط: يُطبع الرمز في الطرفية بدل إرساله
    if (process.env.NODE_ENV === 'production') {
      throw new Error('خدمة البريد غير مهيأة');
    }
    console.warn(`[DEV] رمز ${purpose} للبريد ${to}: ${code}`);
    return;
  }

  await transport.sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject: SUBJECTS[purpose],
    text,
  });
}
