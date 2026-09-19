import dashboardDataHandler from '../backend/api-handlers/dashboard-data.js';

// مسار مباشر للوحة التحكم. وجود ملف API مستقل يمنع الاعتماد على
// vercel.json rewrite /api/:route* عند طلب /api/dashboard-data.
export const config = {
  maxDuration: 60,
};

export default dashboardDataHandler;
