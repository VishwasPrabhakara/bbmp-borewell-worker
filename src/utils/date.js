export function monthLabel(year, monthNumber) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(monthNumber) - 1]}-${String(year).slice(-2)}`;
}

export function formatExcelDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function weeklyLabel(year, monthNumber, weekNumber) {
  return `${monthLabel(year, monthNumber)} W${weekNumber}`;
}

export function weekNumberForDate(date) {
  return Math.min(Math.floor((date.getUTCDate() - 1) / 7) + 1, 4);
}

export function minutesBetween(start, stop) {
  if (!start || !stop) return null;
  const startDate = new Date(start);
  const stopDate = new Date(stop);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(stopDate.getTime())) return null;
  const minutes = (stopDate - startDate) / 60000;
  return minutes > 0 ? minutes : null;
}

export function datePart(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toISOString().slice(0, 10);
}

export function monthLabelFromDatePart(day) {
  if (!day) return "";
  const date = new Date(day);
  if (Number.isNaN(date.getTime())) return "";
  return monthLabel(date.getUTCFullYear(), date.getUTCMonth() + 1);
}

export function dayLabelFromDatePart(day) {
  if (!day) return "";
  const date = new Date(day);
  if (Number.isNaN(date.getTime())) return String(day);
  const dayNumber = String(date.getUTCDate()).padStart(2, "0");
  return `${dayNumber}-${monthLabel(date.getUTCFullYear(), date.getUTCMonth() + 1)}`;
}

export function zipDateTime() {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  return { time, date };
}
