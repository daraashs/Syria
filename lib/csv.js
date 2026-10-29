// ترجمة أسماء الأعمدة والقيم لتصدير CSV بالعربية أو الإنجليزية
export const LABELS = {
  ar: {
    cols: {
      id: 'المعرّف', category: 'الفئة', status: 'الحالة', full_name: 'الاسم الكامل',
      event_date: 'التاريخ', governorate: 'المحافظة', city: 'المدينة', area: 'المنطقة',
      place_of_detention: 'مكان الاحتجاز', notes: 'ملاحظات', review_status: 'حالة المراجعة',
      contact: 'وسيلة التواصل', submitter_email: 'بريد المسجِّل', created_at: 'تاريخ التسجيل',
    },
    values: {
      martyr: 'شهيد', missing: 'مفقود', detainee: 'معتقل', released: 'مُفرج عنه',
      pending: 'بانتظار المراجعة', approved: 'معتمد', rejected: 'مرفوض', merged: 'مدموج',
    },
  },
  en: {
    cols: {
      id: 'ID', category: 'Category', status: 'Status', full_name: 'Full name',
      event_date: 'Date', governorate: 'Governorate', city: 'City', area: 'Area',
      place_of_detention: 'Place of detention', notes: 'Notes', review_status: 'Review status',
      contact: 'Contact', submitter_email: 'Submitter email', created_at: 'Registered on',
    },
    values: {
      martyr: 'Martyr', missing: 'Missing', detainee: 'Detainee', released: 'Released',
      pending: 'Pending review', approved: 'Approved', rejected: 'Rejected', merged: 'Merged',
      'دمشق': 'Damascus', 'ريف دمشق': 'Rif Dimashq', 'حلب': 'Aleppo', 'حمص': 'Homs',
      'حماة': 'Hama', 'اللاذقية': 'Latakia', 'طرطوس': 'Tartus', 'إدلب': 'Idlib',
      'الرقة': 'Raqqa', 'دير الزور': 'Deir ez-Zor', 'الحسكة': 'Al-Hasakah',
      'درعا': 'Daraa', 'السويداء': 'As-Suwayda', 'القنيطرة': 'Quneitra',
    },
  },
};

export const labelFor = (col, lang) => LABELS[lang].cols[col] ?? col;

export function formatCell(col, value, lang) {
  if (value === null || value === undefined) return '';
  if (['category', 'status', 'review_status', 'governorate'].includes(col)) {
    return LABELS[lang].values[value] ?? value;
  }
  return value;
}

// حماية من حقن المعادلات في Excel، وتهريب الفواصل والاقتباس
function escapeCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export const csvLine = (values) => values.map(escapeCell).join(',') + '\r\n';
