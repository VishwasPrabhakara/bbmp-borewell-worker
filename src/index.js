import { neon } from "@neondatabase/serverless";

const FRESHNESS_HOURS = 6;
const RUNNING_TIMEOUT_MINUTES = 30;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,x-admin-password"
    }
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvResponse(headers, rows, filename) {
  const body = [headers, ...rows].map(row => row.map(csvEscape).join(",")).join("\n");
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "access-control-allow-origin": "*"
    }
  });
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function monthLabel(year, monthNumber) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(monthNumber) - 1]}-${String(year).slice(-2)}`;
}

function waterLevelCell(value) {
  if (value === null || value === undefined || value === "") return "";
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.round(numberValue * 100) / 100 : value;
}

function formatExcelDateTime(value) {
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

function notUsableReason(row) {
  const flags = (Array.isArray(row.flags) ? row.flags : []).filter(flag => flag !== "NO_DISCHARGE");
  const rangeDetails = [];
  if (Number(row.water_negative_count) > 0) {
    rangeDetails.push(`${row.water_negative_count} water-level values are negative`);
  }
  if (Number(row.water_too_deep_count) > 0) {
    rangeDetails.push(`${row.water_too_deep_count} water-level/on/off values exceed 1500 ft`);
  }
  if (Number(row.discharge_negative_count) > 0) {
    rangeDetails.push(`${row.discharge_negative_count} discharge values are negative`);
  }
  if (Number(row.discharge_too_high_count) > 0) {
    rangeDetails.push(`${row.discharge_too_high_count} discharge values exceed 20000 LPM`);
  }
  if (Number(row.on_off_logic_error_count) > 0) {
    rangeDetails.push(`${row.on_off_logic_error_count} readings have ON level less than or equal to OFF level`);
  }
  const descriptions = {
    NO_DATA: "No sensor readings are available.",
    TOO_FEW_READINGS: `Only ${row.total_readings || 0} readings are available, so the sensor does not have enough observations for reliable trend analysis.`,
    NO_WATER_LEVEL: "No water-level readings are available from this sensor.",
    STALE_DATA: `Latest reading is old${row.stale_data_days != null ? ` (${Math.round(Number(row.stale_data_days))} days stale)` : ""}.`,
    RANGE_ERRORS: rangeDetails.length
      ? `Invalid value details: ${rangeDetails.join("; ")}.`
      : `${row.range_error_count || 0} values failed range checks. Detailed subtype counts will appear after rerunning sensor QC.`,
    LONG_GAPS: `${row.gap_count || 0} long gaps found in the time series${row.max_gap_hours ? `; maximum gap is ${roundNumber(row.max_gap_hours, 1)} hours` : ""}.`,
    SPIKES: `${row.spike_count || 0} sudden spike/drop events detected between consecutive readings.`,
    FLATLINES: `${row.flatline_count || 0} flatline stretches detected, suggesting the sensor may be stuck or not updating.`,
    DUPLICATE_TIMESTAMPS: "Duplicate timestamps were found in the raw readings.",
    OUTSIDE_BBMP_BOUNDARY: "Sensor location falls outside the BBMP ward boundary layer."
  };

  const reasons = flags.map(flag => descriptions[flag] || flag.replace(/_/g, " ").toLowerCase());
  if (!reasons.length) {
    return "Sensor has data but did not meet GOOD quality criteria. Review water-level continuity and recent data availability.";
  }
  return reasons.join(" ");
}

function median(values) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundNumber(value, decimals = 4) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return null;
  const factor = 10 ** decimals;
  return Math.round(numberValue * factor) / factor;
}

function weeklyLabel(year, monthNumber, weekNumber) {
  return `${monthLabel(year, monthNumber)} W${weekNumber}`;
}

function dropPerDay(points) {
  const available = points
    .filter(point => Number.isFinite(point.level))
    .sort((a, b) => a.position - b.position);
  const drops = [];
  for (let index = 0; index < available.length - 1; index += 1) {
    const current = available[index];
    const next = available[index + 1];
    const days = (next.position - current.position) * 7;
    if (days > 0) drops.push((next.level - current.level) / days);
  }
  return drops.length ? roundNumber(drops.reduce((sum, value) => sum + value, 0) / drops.length, 4) : null;
}

function weeklyWardPayload(rows, qcRows) {
  const weekMap = new Map();
  const sensorMap = new Map();
  const wardMap = new Map();

  for (const row of rows) {
    const year = Number(row.year);
    const monthNumber = Number(row.month_number);
    const weekNumber = Number(row.week_number);
    const weekKey = `${year}-${String(monthNumber).padStart(2, "0")}-${weekNumber}`;
    if (!weekMap.has(weekKey)) {
      weekMap.set(weekKey, {
        key: weekKey,
        year,
        monthNumber,
        weekNumber,
        label: weeklyLabel(year, monthNumber, weekNumber),
        position: weekMap.size
      });
    }

    const wardKey = String(row.ward_no);
    if (!wardMap.has(wardKey)) {
      wardMap.set(wardKey, {
        wardNo: row.ward_no,
        wardName: row.ward_name,
        totalSensors: 0,
        goodSensors: 0,
        notUsableSensors: 0,
        goodPercent: 0,
        avgDropPerDay: null,
        uidCount: 0,
        weekly: [],
        sensors: []
      });
    }

    const sensorKey = String(row.uid);
    if (!sensorMap.has(sensorKey)) {
      sensorMap.set(sensorKey, {
        uid: sensorKey,
        wardNo: row.ward_no,
        wardName: row.ward_name,
        dropPerDay: null,
        pointsByWeek: new Map()
      });
    }
    sensorMap.get(sensorKey).pointsByWeek.set(weekKey, roundNumber(row.water_level_ft, 2));
  }

  for (const row of qcRows) {
    const wardKey = String(row.ward_no);
    if (!wardMap.has(wardKey)) {
      wardMap.set(wardKey, {
        wardNo: row.ward_no,
        wardName: row.ward_name,
        totalSensors: 0,
        goodSensors: 0,
        notUsableSensors: 0,
        goodPercent: 0,
        avgDropPerDay: null,
        uidCount: 0,
        weekly: [],
        sensors: []
      });
    }
    const ward = wardMap.get(wardKey);
    ward.totalSensors += 1;
    if (row.qc_status === "GOOD") ward.goodSensors += 1;
  }

  const weeks = Array.from(weekMap.values()).sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    if (a.monthNumber !== b.monthNumber) return a.monthNumber - b.monthNumber;
    return a.weekNumber - b.weekNumber;
  });
  weeks.forEach((week, index) => { week.position = index; });

  const sensors = Array.from(sensorMap.values()).map(sensor => {
    const points = weeks.map(week => ({
      key: week.key,
      label: week.label,
      position: week.position,
      level: sensor.pointsByWeek.get(week.key) ?? null
    }));
    return {
      uid: sensor.uid,
      wardNo: sensor.wardNo,
      wardName: sensor.wardName,
      dropPerDay: dropPerDay(points),
      points: points.map(({ label, level }) => ({ label, level }))
    };
  });

  for (const sensor of sensors) {
    const ward = wardMap.get(String(sensor.wardNo));
    if (ward) ward.sensors.push(sensor);
  }

  for (const ward of wardMap.values()) {
    ward.notUsableSensors = Math.max(ward.totalSensors - ward.goodSensors, 0);
    ward.goodPercent = ward.totalSensors ? roundNumber((ward.goodSensors / ward.totalSensors) * 100, 1) : 0;
    ward.uidCount = ward.sensors.length;
    const wardDrops = ward.sensors.map(sensor => sensor.dropPerDay).filter(value => Number.isFinite(value));
    ward.avgDropPerDay = wardDrops.length ? roundNumber(wardDrops.reduce((sum, value) => sum + value, 0) / wardDrops.length, 4) : null;
    ward.weekly = weeks.map(week => {
      const values = ward.sensors
        .map(sensor => sensor.points.find(point => point.label === week.label)?.level)
        .filter(value => Number.isFinite(value));
      return {
        label: week.label,
        averageLevel: values.length ? roundNumber(values.reduce((sum, value) => sum + value, 0) / values.length, 2) : null,
        medianLevel: median(values),
        sensorCount: values.length
      };
    });
    ward.sensors.sort((a, b) => String(a.uid).localeCompare(String(b.uid)));
  }

  return {
    weeks: weeks.map(({ label }) => label),
    wards: Array.from(wardMap.values()).sort((a, b) => Number(a.wardNo) - Number(b.wardNo))
  };
}

const CRC32_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function stringBytes(value) {
  return new TextEncoder().encode(value);
}

function concatBytes(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function u16(value) {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value) {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff
  ]);
}

function zipDateTime() {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  return { time, date };
}

function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { time, date } = zipDateTime();

  for (const file of files) {
    const nameBytes = stringBytes(file.name);
    const dataBytes = typeof file.data === "string" ? stringBytes(file.data) : file.data;
    const checksum = crc32(dataBytes);

    const localHeader = concatBytes([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(time),
      u16(date),
      u32(checksum),
      u32(dataBytes.length),
      u32(dataBytes.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes
    ]);
    localParts.push(localHeader, dataBytes);

    const centralHeader = concatBytes([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(time),
      u16(date),
      u32(checksum),
      u32(dataBytes.length),
      u32(dataBytes.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes
    ]);
    centralParts.push(centralHeader);
    offset += localHeader.length + dataBytes.length;
  }

  const centralDirectory = concatBytes(centralParts);
  const endRecord = concatBytes([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralDirectory.length),
    u32(offset),
    u16(0)
  ]);

  return concatBytes([...localParts, centralDirectory, endRecord]);
}

function columnName(index) {
  let name = "";
  while (index > 0) {
    const remainder = (index - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    index = Math.floor((index - 1) / 26);
  }
  return name;
}

function cellAddress(row, column) {
  return `${columnName(column)}${row}`;
}

function inlineCell(row, column, value, style = 3) {
  if (value === null || value === undefined || value === "") return "";
  return `<c r="${cellAddress(row, column)}" s="${style}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
}

function numberCell(row, column, value, style = 4) {
  if (value === null || value === undefined || value === "") return "";
  return `<c r="${cellAddress(row, column)}" s="${style}"><v>${xmlEscape(value)}</v></c>`;
}

function tableExcelResponse(headers, rows, filename, sheetName = "Sheet1") {
  const sheetRows = [
    `<row r="1">${headers.map((header, index) => inlineCell(1, index + 1, header, 2)).join("")}</row>`
  ];

  rows.forEach((row, rowIndex) => {
    const excelRow = rowIndex + 2;
    const cells = row.map((value, colIndex) => {
      if (typeof value === "number" && Number.isFinite(value)) {
        return numberCell(excelRow, colIndex + 1, value, 4);
      }
      return inlineCell(excelRow, colIndex + 1, value, 3);
    });
    sheetRows.push(`<row r="${excelRow}">${cells.join("")}</row>`);
  });

  const maxColumn = Math.max(headers.length, 1);
  const maxRow = Math.max(rows.length + 1, 1);
  const cols = `<col min="1" max="${maxColumn}" width="18" customWidth="1"/>`;
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:${cellAddress(maxRow, maxColumn)}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${cols}</cols>
  <sheetData>${sheetRows.join("")}</sheetData>
</worksheet>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9E2F3"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF9CA3AF"/></left><right style="thin"><color rgb="FF9CA3AF"/></right><top style="thin"><color rgb="FF9CA3AF"/></top><bottom style="thin"><color rgb="FF9CA3AF"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="5">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="3" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"/>
    <xf numFmtId="2" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  const zip = makeZip([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    },
    { name: "xl/workbook.xml", data: workbook },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    },
    { name: "xl/worksheets/sheet1.xml", data: worksheet },
    { name: "xl/styles.xml", data: styles }
  ]);

  return new Response(zip, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "access-control-allow-origin": "*"
    }
  });
}

function weeklyLevelsExcelResponse(rows, filename) {
  const monthMap = new Map();
  const sensorMap = new Map();

  for (const row of rows) {
    const monthKey = `${row.year}-${String(row.month_number).padStart(2, "0")}`;
    if (!monthMap.has(monthKey)) {
      monthMap.set(monthKey, {
        key: monthKey,
        year: Number(row.year),
        monthNumber: Number(row.month_number),
        label: monthLabel(row.year, row.month_number)
      });
    }

    const sensorKey = String(row.uid);
    if (!sensorMap.has(sensorKey)) {
      sensorMap.set(sensorKey, {
        wardNo: row.ward_no,
        wardName: row.ward_name,
        uid: sensorKey,
        months: new Map()
      });
    }

    sensorMap.get(sensorKey).months.set(monthKey, row);
  }

  const months = Array.from(monthMap.values())
    .filter(month => month.year > 2026 || (month.year === 2026 && month.monthNumber >= 1))
    .sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      return a.monthNumber - b.monthNumber;
    });

  const sensors = Array.from(sensorMap.values()).sort((a, b) => {
    const wardA = Number(a.wardNo);
    const wardB = Number(b.wardNo);
    if (Number.isFinite(wardA) && Number.isFinite(wardB) && wardA !== wardB) return wardA - wardB;
    return String(a.wardNo).localeCompare(String(b.wardNo))
      || String(a.wardName || "").localeCompare(String(b.wardName || ""))
      || String(a.uid).localeCompare(String(b.uid));
  });

  const wardSpans = new Map();
  for (let index = 0; index < sensors.length; index += 1) {
    const sensor = sensors[index];
    const wardKey = `${sensor.wardNo || ""}|${sensor.wardName || ""}`;
    if (!wardSpans.has(wardKey)) {
      wardSpans.set(wardKey, { start: index, count: 0 });
    }
    wardSpans.get(wardKey).count += 1;
  }

  const merges = ["A1:A2", "B1:B2", "C1:C2"];
  const sheetRows = [];
  const firstRowCells = [
    inlineCell(1, 1, "Ward Num", 1),
    inlineCell(1, 2, "Ward Name", 1),
    inlineCell(1, 3, "UID", 1)
  ];
  const secondRowCells = [];
  let column = 4;
  for (const month of months) {
    firstRowCells.push(inlineCell(1, column, month.label, 2));
    merges.push(`${cellAddress(1, column)}:${cellAddress(1, column + 3)}`);
    for (let week = 1; week <= 4; week += 1) {
      secondRowCells.push(inlineCell(2, column, `Week ${week}`, 2));
      column += 1;
    }
  }
  sheetRows.push(`<row r="1">${firstRowCells.join("")}</row>`);
  sheetRows.push(`<row r="2">${secondRowCells.join("")}</row>`);

  sensors.forEach((sensor, index) => {
    const wardKey = `${sensor.wardNo || ""}|${sensor.wardName || ""}`;
    const wardSpan = wardSpans.get(wardKey);
    const rowNumber = index + 3;
    const cells = [];
    if (wardSpan.start === index) {
      cells.push(inlineCell(rowNumber, 1, sensor.wardNo, 5));
      cells.push(inlineCell(rowNumber, 2, sensor.wardName, 5));
      if (wardSpan.count > 1) {
        merges.push(`A${rowNumber}:A${rowNumber + wardSpan.count - 1}`);
        merges.push(`B${rowNumber}:B${rowNumber + wardSpan.count - 1}`);
      }
    }
    cells.push(inlineCell(rowNumber, 3, sensor.uid, 6));
    let dataColumn = 4;
    for (const month of months) {
      const row = sensor.months.get(month.key) || {};
      for (let week = 1; week <= 4; week += 1) {
        const value = waterLevelCell(row[`week_${week}_start_water_level_ft`]);
        cells.push(numberCell(rowNumber, dataColumn, value, 4));
        dataColumn += 1;
      }
    }
    sheetRows.push(`<row r="${rowNumber}">${cells.join("")}</row>`);
  });

  const mergeXml = merges.length
    ? `<mergeCells count="${merges.length}">${merges.map(ref => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`
    : "";
  const maxColumn = 3 + (months.length * 4);
  const cols = [
    '<col min="1" max="1" width="12" customWidth="1"/>',
    '<col min="2" max="2" width="24" customWidth="1"/>',
    '<col min="3" max="3" width="20" customWidth="1"/>',
    maxColumn >= 4 ? `<col min="4" max="${maxColumn}" width="11" customWidth="1"/>` : ""
  ].join("");

  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:${cellAddress(Math.max(2, sensors.length + 2), Math.max(3, maxColumn))}"/>
  <sheetViews><sheetView workbookViewId="0"><pane xSplit="3" ySplit="2" topLeftCell="D3" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>
  <cols>${cols}</cols>
  <sheetData>${sheetRows.join("")}</sheetData>
  ${mergeXml}
</worksheet>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Weekly Start Levels" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9E2F3"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF9CA3AF"/></left><right style="thin"><color rgb="FF9CA3AF"/></right><top style="thin"><color rgb="FF9CA3AF"/></top><bottom style="thin"><color rgb="FF9CA3AF"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="7">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="3" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"/>
    <xf numFmtId="2" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="2" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="49" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  const zip = makeZip([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    },
    {
      name: "xl/workbook.xml",
      data: workbook
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: worksheet
    },
    {
      name: "xl/styles.xml",
      data: styles
    }
  ]);

  return new Response(zip, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "access-control-allow-origin": "*"
    }
  });
}

function isStale(lastFinished) {
  if (!lastFinished) return true;
  const last = new Date(lastFinished).getTime();
  return Date.now() - last > FRESHNESS_HOURS * 60 * 60 * 1000;
}

function isRunningStale(lastStarted) {
  if (!lastStarted) return false;
  const started = new Date(lastStarted).getTime();
  return Date.now() - started > RUNNING_TIMEOUT_MINUTES * 60 * 1000;
}

function statusPayload(row = {}) {
  return {
    running: !!row.running,
    ok: row.ok,
    lastStarted: row.last_started || null,
    lastFinished: row.last_finished || null,
    message: row.message || ""
  };
}

function isMissingRelation(error) {
  return /relation .* does not exist/i.test(String(error?.message || error));
}

function byteaToBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return new Uint8Array(value);
  if (value?.data && Array.isArray(value.data)) return new Uint8Array(value.data);
  if (typeof value === "string" && value.startsWith("\\x")) {
    const bytes = new Uint8Array((value.length - 2) / 2);
    for (let index = 2; index < value.length; index += 2) {
      bytes[(index - 2) / 2] = Number.parseInt(value.slice(index, index + 2), 16);
    }
    return bytes;
  }
  throw new Error("Unsupported uploaded payload format");
}

async function gunzipJson(value) {
  const bytes = byteaToBytes(value);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).json();
}

function requireAdmin(request, env) {
  const expected = env.ADMIN_PASSWORD;
  const provided = request.headers.get("x-admin-password") || "";
  return !!expected && provided === expected;
}

async function triggerGithubAction(env) {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/refresh.yml/dispatches`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "accept": "application/vnd.github+json",
      "user-agent": "bbmp-borewell-worker"
    },
    body: JSON.stringify({ ref: env.GH_BRANCH || "main" })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub dispatch failed: ${response.status} ${text}`);
  }
}

async function ensureUploadedTables(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS uploaded_type_a_readings (
      id SERIAL PRIMARY KEY,
      uid TEXT REFERENCES sensors(uid) ON DELETE CASCADE,
      lat DOUBLE PRECISION NULL,
      lng DOUBLE PRECISION NULL,
      source_file TEXT NULL,
      time TIMESTAMP NOT NULL,
      discharge DOUBLE PRECISION NULL,
      power_kw DOUBLE PRECISION NULL,
      pump_status TEXT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS uploaded_type_b_sessions (
      id SERIAL PRIMARY KEY,
      uid TEXT REFERENCES sensors(uid) ON DELETE CASCADE,
      lat DOUBLE PRECISION NULL,
      lng DOUBLE PRECISION NULL,
      source_file TEXT NULL,
      start_time TIMESTAMP NOT NULL,
      stop_time TIMESTAMP NOT NULL,
      tts_start_seconds DOUBLE PRECISION NULL,
      water_level_start_m DOUBLE PRECISION NULL,
      water_level_start_ft DOUBLE PRECISION NULL,
      tts_stop_seconds DOUBLE PRECISION NULL,
      water_level_stop_m DOUBLE PRECISION NULL,
      water_level_stop_ft DOUBLE PRECISION NULL,
      session_duration_min DOUBLE PRECISION NULL
    )
  `;
}

async function ensureCompactUploadTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS uploaded_sensor_series (
      uid TEXT PRIMARY KEY REFERENCES sensors(uid) ON DELETE CASCADE,
      lat DOUBLE PRECISION NULL,
      lng DOUBLE PRECISION NULL,
      source_file_count INTEGER DEFAULT 0,
      first_data_at TIMESTAMP NULL,
      last_data_at TIMESTAMP NULL,
      water_readings INTEGER DEFAULT 0,
      discharge_readings INTEGER DEFAULT 0,
      total_readings INTEGER DEFAULT 0,
      payload_gzip BYTEA NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;
}

async function recalculateSummaries(sql) {
  await ensureUploadedTables(sql);
  await sql`
    UPDATE sensors
    SET
      has_data = false,
      data_category = 'none',
      first_data_at = NULL,
      last_data_at = NULL,
      water_readings = 0,
      discharge_readings = 0,
      total_readings = 0
  `;
  await sql`
    WITH uploaded_points AS (
      SELECT DISTINCT uid, time, false AS has_water, true AS has_discharge
      FROM uploaded_type_a_readings
      UNION ALL
      SELECT DISTINCT uid, start_time AS time, true AS has_water, false AS has_discharge
      FROM uploaded_type_b_sessions
      UNION ALL
      SELECT DISTINCT uid, stop_time AS time, true AS has_water, false AS has_discharge
      FROM uploaded_type_b_sessions
    ),
    uploaded_uids AS (
      SELECT DISTINCT uid FROM uploaded_points
    ),
    uploaded_summary AS (
      SELECT
        uid,
        MIN(time) AS first_data_at,
        MAX(time) AS last_data_at,
        COUNT(*) FILTER (WHERE has_water) AS water_readings,
        COUNT(*) FILTER (WHERE has_discharge) AS discharge_readings
      FROM uploaded_points
      GROUP BY uid
    ),
    kh_summary AS (
      SELECT
        uid,
        MIN(time) AS first_data_at,
        MAX(time) AS last_data_at,
        COUNT(*) FILTER (WHERE water_level IS NOT NULL OR on_level IS NOT NULL OR off_level IS NOT NULL) AS water_readings,
        COUNT(*) FILTER (WHERE discharge IS NOT NULL) AS discharge_readings
      FROM water_levels
      WHERE uid NOT IN (SELECT uid FROM uploaded_uids)
      GROUP BY uid
    ),
    summary AS (
      SELECT * FROM uploaded_summary
      UNION ALL
      SELECT * FROM kh_summary
    )
    UPDATE sensors
    SET
      first_data_at = summary.first_data_at,
      last_data_at = summary.last_data_at,
      water_readings = summary.water_readings,
      discharge_readings = summary.discharge_readings,
      total_readings = summary.water_readings + summary.discharge_readings,
      has_data = summary.water_readings > 0 OR summary.discharge_readings > 0,
      data_category = CASE
        WHEN summary.water_readings > 0 AND summary.discharge_readings > 0 THEN 'both'
        WHEN summary.water_readings > 0 THEN 'water'
        WHEN summary.discharge_readings > 0 THEN 'discharge'
        ELSE 'none'
      END
    FROM summary
    WHERE sensors.uid = summary.uid
  `;
}

async function upsertAdminSensors(sql, rowsJson) {
  await sql`
    WITH input AS (
      SELECT uid, MAX(lat) AS lat, MAX(lng) AS lng
      FROM jsonb_to_recordset(${rowsJson}::jsonb) AS x(uid text, lat double precision, lng double precision)
      WHERE uid IS NOT NULL AND uid <> ''
      GROUP BY uid
    )
    INSERT INTO sensors (uid, lat, lng, data_category, has_data, water_readings, discharge_readings, total_readings)
    SELECT uid, lat, lng, 'none', false, 0, 0, 0
    FROM input
    ON CONFLICT (uid) DO UPDATE SET
      lat = COALESCE(EXCLUDED.lat, sensors.lat),
      lng = COALESCE(EXCLUDED.lng, sensors.lng)
  `;
}

async function uploadTypeA(sql, rows) {
  await ensureUploadedTables(sql);
  const rowsJson = JSON.stringify(rows);
  await upsertAdminSensors(sql, rowsJson);
  await sql`
    WITH raw_input AS (
      SELECT *
      FROM jsonb_to_recordset(${rowsJson}::jsonb) AS x(
        uid text,
        lat double precision,
        lng double precision,
        source_file text,
        time timestamp,
        discharge double precision,
        power_kw double precision,
        pump_status text
      )
    ),
    input AS (
      SELECT
        uid,
        MAX(lat) AS lat,
        MAX(lng) AS lng,
        MAX(source_file) AS source_file,
        time,
        MAX(discharge) AS discharge,
        MAX(power_kw) AS power_kw,
        MAX(pump_status) AS pump_status
      FROM raw_input
      WHERE uid IS NOT NULL AND uid <> '' AND time IS NOT NULL
      GROUP BY uid, time
    )
    INSERT INTO uploaded_type_a_readings (uid, lat, lng, source_file, time, discharge, power_kw, pump_status)
    SELECT uid, lat, lng, source_file, time, discharge, power_kw, pump_status
    FROM input
    WHERE NOT EXISTS (
      SELECT 1
      FROM uploaded_type_a_readings existing
      WHERE existing.uid = input.uid
        AND existing.time = input.time
    )
  `;
}

async function uploadTypeB(sql, rows) {
  await ensureUploadedTables(sql);
  const rowsJson = JSON.stringify(rows);
  await upsertAdminSensors(sql, rowsJson);
  await sql`
    WITH raw_input AS (
      SELECT *
      FROM jsonb_to_recordset(${rowsJson}::jsonb) AS x(
        uid text,
        lat double precision,
        lng double precision,
        source_file text,
        start_time timestamp,
        stop_time timestamp,
        tts_start_seconds double precision,
        water_level_start_m double precision,
        water_level_start_ft double precision,
        tts_stop_seconds double precision,
        water_level_stop_m double precision,
        water_level_stop_ft double precision,
        session_duration_min double precision
      )
    ),
    input AS (
      SELECT
        uid,
        MAX(lat) AS lat,
        MAX(lng) AS lng,
        MAX(source_file) AS source_file,
        start_time,
        stop_time,
        MAX(tts_start_seconds) AS tts_start_seconds,
        MAX(water_level_start_m) AS water_level_start_m,
        MAX(water_level_start_ft) AS water_level_start_ft,
        MAX(tts_stop_seconds) AS tts_stop_seconds,
        MAX(water_level_stop_m) AS water_level_stop_m,
        MAX(water_level_stop_ft) AS water_level_stop_ft,
        MAX(session_duration_min) AS session_duration_min
      FROM raw_input
      WHERE uid IS NOT NULL AND uid <> '' AND start_time IS NOT NULL AND stop_time IS NOT NULL
      GROUP BY uid, start_time, stop_time
    )
    INSERT INTO uploaded_type_b_sessions (
      uid, lat, lng, source_file, start_time, stop_time,
      tts_start_seconds, water_level_start_m, water_level_start_ft,
      tts_stop_seconds, water_level_stop_m, water_level_stop_ft,
      session_duration_min
    )
    SELECT
      uid, lat, lng, source_file, start_time, stop_time,
      tts_start_seconds, water_level_start_m, water_level_start_ft,
      tts_stop_seconds, water_level_stop_m, water_level_stop_ft,
      session_duration_min
    FROM input
    WHERE NOT EXISTS (
      SELECT 1
      FROM uploaded_type_b_sessions existing
      WHERE existing.uid = input.uid
        AND existing.start_time = input.start_time
        AND existing.stop_time = input.stop_time
    )
  `;
}

function adminPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BBMP Borewell Admin Upload</title>
  <style>
    body{font-family:Arial,sans-serif;margin:0;background:#f5f7fb;color:#172033}
    main{max-width:760px;margin:40px auto;padding:24px;background:white;border:1px solid #dde3ee;border-radius:8px}
    label{display:block;margin:16px 0 6px;font-weight:700}
    input,button{font:inherit}
    input[type=password],input[type=file]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #c8d1df;border-radius:6px}
    button{margin-top:18px;padding:10px 14px;border:0;border-radius:6px;background:#1f6feb;color:white;font-weight:700;cursor:pointer}
    button:disabled{opacity:.6;cursor:wait}
    pre{white-space:pre-wrap;background:#101828;color:#d1e7ff;padding:14px;border-radius:6px;min-height:180px;max-height:420px;overflow:auto}
  </style>
</head>
<body>
  <main>
    <h1>Admin Upload</h1>
    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="current-password">
    <label for="zip">TypeA/TypeB zip file</label>
    <input id="zip" type="file" accept=".zip">
    <button id="upload">Upload parsed data</button>
    <pre id="log">Choose the zip and enter the admin password.</pre>
  </main>
  <script src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"></script>
  <script>
    const M_TO_FT = 3.280839895;
    const BATCH_SIZE = 1500;
    const logEl = document.getElementById('log');
    const button = document.getElementById('upload');
    const passwordEl = document.getElementById('password');
    const zipEl = document.getElementById('zip');

    function log(message) {
      logEl.textContent += "\\n" + message;
      logEl.scrollTop = logEl.scrollHeight;
    }

    function parseCSV(text) {
      const rows = [];
      let row = [];
      let cell = '';
      let quoted = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];
        if (ch === '"' && quoted && next === '"') {
          cell += '"';
          i++;
        } else if (ch === '"') {
          quoted = !quoted;
        } else if (ch === ',' && !quoted) {
          row.push(cell);
          cell = '';
        } else if ((ch === '\\n' || ch === '\\r') && !quoted) {
          if (ch === '\\r' && next === '\\n') i++;
          row.push(cell);
          if (row.some(value => value.trim() !== '')) rows.push(row);
          row = [];
          cell = '';
        } else {
          cell += ch;
        }
      }
      if (cell || row.length) {
        row.push(cell);
        if (row.some(value => value.trim() !== '')) rows.push(row);
      }
      return rows;
    }

    function metaFromRow(row) {
      const meta = {};
      for (const cell of row || []) {
        const index = cell.indexOf(':');
        if (index === -1) continue;
        meta[cell.slice(0, index).trim().toLowerCase()] = cell.slice(index + 1).trim();
      }
      return meta;
    }

    function number(value) {
      const text = String(value ?? '').replace(/,/g, '').trim();
      if (!text) return null;
      const parsed = Number(text);
      return Number.isFinite(parsed) ? parsed : null;
    }

    function khTime(value) {
      const match = String(value || '').trim().match(/^(\\d{2})(\\d{2})(\\d{2})\\s+(\\d{2})(\\d{2})(\\d{2})$/);
      if (!match) return null;
      const [, dd, mm, yy, hh, mi, ss] = match;
      const year = Number(yy) + 2000;
      return new Date(Date.UTC(year, Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss))).toISOString();
    }

    function fileInfo(name) {
      const match = name.match(/(\\d{15}).*?(TypeA|TypeB)\\.csv$/i);
      if (!match) return null;
      return { uid: match[1], kind: match[2].toUpperCase() };
    }

    function objectRows(rows) {
      const header = rows[1] || [];
      return rows.slice(2).map(raw => Object.fromEntries(header.map((name, index) => [name, raw[index] || ''])));
    }

    async function postRows(path, rows, password) {
      let sent = 0;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const response = await fetch(path, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-admin-password': password
          },
          body: JSON.stringify({ rows: batch })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Upload failed');
        sent += payload.count || batch.length;
      }
      return sent;
    }

    async function flushQueue(queue, path, password) {
      if (!queue.length) return 0;
      const batch = queue.splice(0, queue.length);
      return postRows(path, batch, password);
    }

    async function flushIfNeeded(queue, path, password) {
      let sent = 0;
      while (queue.length >= BATCH_SIZE) {
        const batch = queue.splice(0, BATCH_SIZE);
        sent += await postRows(path, batch, password);
      }
      return sent;
    }

    async function upload() {
      const file = zipEl.files[0];
      const password = passwordEl.value;
      if (!file) throw new Error('Choose a zip file first.');
      if (!password) throw new Error('Enter the admin password.');
      if (!window.JSZip) throw new Error('Could not load JSZip. Check internet access to cdn.jsdelivr.net, then refresh this admin page.');

      button.disabled = true;
      logEl.textContent = 'Reading zip...';
      const zip = await JSZip.loadAsync(file);
      let typeACount = 0;
      let typeBCount = 0;
      let files = 0;
      const typeAQueue = [];
      const typeBQueue = [];

      for (const entry of Object.values(zip.files)) {
        if (entry.dir || !entry.name.toLowerCase().endsWith('.csv')) continue;
        const info = fileInfo(entry.name);
        if (!info) continue;
        files++;
        const text = await entry.async('text');
        const csv = parseCSV(text);
        if (csv.length < 3) continue;
        const meta = metaFromRow(csv[0]);
        const lat = number(meta.lat);
        const lng = number(meta.long);
        const rows = objectRows(csv);

        if (info.kind === 'TYPEA') {
          const dischargeColumn = Object.keys(rows[0] || {}).find(name => name.toLowerCase().includes('discharge'));
          const multiplier = dischargeColumn && dischargeColumn.toLowerCase().includes('kl/min') ? 1000 : 1;
          const parsed = rows.map(row => {
            const time = khTime(row['timestamp (ddmmyy hhmmss)']);
            const rawDischarge = number(row[dischargeColumn]);
            const discharge = rawDischarge === null ? null : rawDischarge * multiplier;
            if (!time || !Number.isFinite(discharge)) return null;
            return {
              uid: info.uid,
              lat,
              lng,
              source_file: entry.name.split('/').pop(),
              time,
              discharge,
              power_kw: number(row['power (kW)']),
              pump_status: row.pump_status || null
            };
          }).filter(Boolean);
          typeAQueue.push(...parsed);
          typeACount += await flushIfNeeded(typeAQueue, '/api/admin/upload-type-a', password);
        }

        if (info.kind === 'TYPEB') {
          const parsed = rows.map(row => {
            const start = khTime(row['timestamp_start (ddmmyy hhmmss)']);
            const stop = khTime(row['timestamp_stop (ddmmyy hhmmss)']);
            const startM = number(row['water level at start (m below surface)']);
            const stopM = number(row['water level at stop (m below surface)']);
            if (!start || !stop || startM === null || stopM === null || stopM <= startM) return null;
            return {
              uid: info.uid,
              lat,
              lng,
              source_file: entry.name.split('/').pop(),
              start_time: start,
              stop_time: stop,
              tts_start_seconds: number(row['TTS at start (seconds)']),
              water_level_start_m: startM,
              water_level_start_ft: startM * M_TO_FT,
              tts_stop_seconds: number(row['TTS at stop (seconds)']),
              water_level_stop_m: stopM,
              water_level_stop_ft: stopM * M_TO_FT,
              session_duration_min: number(row['session duration (min)'])
            };
          }).filter(Boolean);
          typeBQueue.push(...parsed);
          typeBCount += await flushIfNeeded(typeBQueue, '/api/admin/upload-type-b', password);
        }

        if (files % 25 === 0) {
          log('Processed ' + files + ' files. Uploaded TypeA rows: ' + typeACount + ', TypeB sessions: ' + typeBCount + '. Queued: ' + (typeAQueue.length + typeBQueue.length));
        }
      }

      typeACount += await flushQueue(typeAQueue, '/api/admin/upload-type-a', password);
      typeBCount += await flushQueue(typeBQueue, '/api/admin/upload-type-b', password);
      log('Finished uploading rows. Updating summaries...');

      const response = await fetch('/api/admin/recalculate-summaries', {
        method: 'POST',
        headers: { 'x-admin-password': password }
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Summary update failed');
      log('Done. Uploaded TypeA rows: ' + typeACount + ', TypeB sessions: ' + typeBCount);
      button.disabled = false;
    }

    button.addEventListener('click', () => upload().catch(error => {
      log('ERROR: ' + error.message);
      button.disabled = false;
    }));
  </script>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return json({ ok: true });

    const url = new URL(request.url);
    const sql = neon(env.DATABASE_URL);

    try {
      if (url.pathname === "/") {
        return json({ message: "BBMP Borewell Worker API running" });
      }

      if (url.pathname === "/admin-upload") {
        return html(adminPage());
      }

      if (url.pathname === "/api/admin/upload-type-a" && request.method === "POST") {
        if (!requireAdmin(request, env)) return json({ error: "Unauthorized" }, 401);
        const payload = await request.json();
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        try {
          await uploadTypeA(sql, rows);
          return json({ ok: true, count: rows.length });
        } catch (error) {
          return json({ error: String(error.message || error), route: "upload-type-a" }, 500);
        }
      }

      if (url.pathname === "/api/admin/upload-type-b" && request.method === "POST") {
        if (!requireAdmin(request, env)) return json({ error: "Unauthorized" }, 401);
        const payload = await request.json();
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        try {
          await uploadTypeB(sql, rows);
          return json({ ok: true, count: rows.length });
        } catch (error) {
          return json({ error: String(error.message || error), route: "upload-type-b" }, 500);
        }
      }

      if (url.pathname === "/api/admin/recalculate-summaries" && request.method === "POST") {
        if (!requireAdmin(request, env)) return json({ error: "Unauthorized" }, 401);
        await recalculateSummaries(sql);
        return json({ ok: true });
      }

      if (url.pathname === "/api/status") {
        const rows = await sql`
          SELECT running, ok, last_started, last_finished, message
          FROM refresh_status
          WHERE id = 1
        `;
        return json(statusPayload(rows[0]));
      }

      if (url.pathname === "/api/refresh") {
        const rows = await sql`
          SELECT running, ok, last_started, last_finished, message
          FROM refresh_status
          WHERE id = 1
        `;
        const status = rows[0];

        if (status?.running && !isRunningStale(status.last_started)) {
          return json({ started: false, reason: "already_running", status: statusPayload(status) });
        }

        if (status?.ok !== false && status && !isStale(status.last_finished)) {
          return json({ started: false, reason: "fresh", status: statusPayload(status) });
        }

        await sql`
          INSERT INTO refresh_status (id, running, ok, last_started, message)
          VALUES (1, true, true, NOW(), 'Refresh queued')
          ON CONFLICT (id) DO UPDATE SET
            running = true,
            ok = true,
            last_started = NOW(),
            message = 'Refresh queued'
        `;

        await triggerGithubAction(env);

        return json({ started: true });
      }

      if (url.pathname === "/api/sensors") {
        await ensureCompactUploadTable(sql);
        const rows = await sql`
          SELECT
            COALESCE(s.uid, uploaded.uid) AS uid,
            COALESCE(uploaded.lat, s.lat) AS lat,
            COALESCE(uploaded.lng, s.lng) AS lng,
            s.ward_no,
            s.ward_name,
            CASE
              WHEN uploaded.uid IS NOT NULL AND COALESCE(uploaded.water_readings, 0) > 0 AND COALESCE(uploaded.discharge_readings, 0) > 0 THEN 'both'
              WHEN uploaded.uid IS NOT NULL AND COALESCE(uploaded.water_readings, 0) > 0 THEN 'water'
              WHEN uploaded.uid IS NOT NULL AND COALESCE(uploaded.discharge_readings, 0) > 0 THEN 'discharge'
              ELSE COALESCE(s.data_category, 'none')
            END AS data_category,
            CASE
              WHEN uploaded.uid IS NOT NULL THEN COALESCE(uploaded.water_readings, 0) > 0 OR COALESCE(uploaded.discharge_readings, 0) > 0
              ELSE COALESCE(s.has_data, false)
            END AS has_data,
            COALESCE(uploaded.first_data_at, s.first_data_at) AS first_data_at,
            COALESCE(uploaded.last_data_at, s.last_data_at) AS last_data_at,
            COALESCE(uploaded.water_readings, s.water_readings, 0) AS water_readings,
            COALESCE(uploaded.discharge_readings, s.discharge_readings, 0) AS discharge_readings,
            COALESCE(uploaded.total_readings, s.total_readings, 0) AS total_readings
          FROM sensors s
          FULL OUTER JOIN uploaded_sensor_series uploaded ON uploaded.uid = s.uid
          ORDER BY COALESCE(s.uid, uploaded.uid)
        `;

        return json({
          sensors: rows.map(row => ({
            uid: row.uid,
            lat: row.lat,
            lng: row.lng,
            wardNo: row.ward_no,
            wardName: row.ward_name,
            dataCategory: row.data_category || "none",
            hasData: !!row.has_data,
            firstDataAt: row.first_data_at,
            lastDataAt: row.last_data_at,
            waterReadings: row.water_readings || 0,
            dischargeReadings: row.discharge_readings || 0,
            totalReadings: row.total_readings || 0
          })),
          sensorsWithWaterData: rows.filter(row => row.has_data).length
        });
      }

      if (url.pathname === "/api/qc/sensors") {
        const wardNo = url.searchParams.get("ward_no");
        const status = url.searchParams.get("status");
        const rows = wardNo && status ? await sql`
          SELECT *
          FROM sensor_qc_summary
          WHERE ward_no = ${wardNo}
            AND qc_status = ${status}
          ORDER BY ward_no, overall_qc_score DESC, uid
        ` : wardNo ? await sql`
          SELECT *
          FROM sensor_qc_summary
          WHERE ward_no = ${wardNo}
          ORDER BY overall_qc_score DESC, uid
        ` : status ? await sql`
          SELECT *
          FROM sensor_qc_summary
          WHERE qc_status = ${status}
          ORDER BY ward_no, overall_qc_score DESC, uid
        ` : await sql`
          SELECT *
          FROM sensor_qc_summary
          ORDER BY ward_no, overall_qc_score DESC, uid
        `;

        return json({
          sensors: rows.map(row => ({
            uid: row.uid,
            wardNo: row.ward_no,
            wardName: row.ward_name,
            lat: row.lat,
            lng: row.lng,
            dataSource: row.data_source,
            firstDataAt: row.first_data_at,
            lastDataAt: row.last_data_at,
            totalReadings: row.total_readings || 0,
            validReadings: row.valid_readings || 0,
            invalidReadings: row.invalid_readings || 0,
            waterReadings: row.water_readings || 0,
            dischargeReadings: row.discharge_readings || 0,
            duplicateTimestampCount: row.duplicate_timestamp_count || 0,
            gapCount: row.gap_count || 0,
            maxGapHours: row.max_gap_hours || 0,
            rangeErrorCount: row.range_error_count || 0,
            spikeCount: row.spike_count || 0,
            flatlineCount: row.flatline_count || 0,
            staleDataDays: row.stale_data_days,
            coverageScore: row.coverage_score || 0,
            rangeScore: row.range_score || 0,
            stabilityScore: row.stability_score || 0,
            recentDataScore: row.recent_data_score || 0,
            overallQcScore: row.overall_qc_score || 0,
            qcStatus: row.qc_status || "NO_DATA",
            flags: Array.isArray(row.flags) ? row.flags : [],
            updatedAt: row.updated_at
          })),
          count: rows.length
        });
      }

      if (
        url.pathname === "/api/qc/not-usable-sensors.xlsx"
        || url.pathname === "/api/qc/not-usable-sensors.csv"
      ) {
        const rows = await sql`
          SELECT *
          FROM sensor_qc_summary
          WHERE qc_status <> 'GOOD'
            AND COALESCE(total_readings, 0) > 0
          ORDER BY
            CASE qc_status
              WHEN 'POOR' THEN 1
              WHEN 'USABLE_WITH_CAUTION' THEN 2
              WHEN 'INSUFFICIENT_DATA' THEN 3
              ELSE 4
            END,
            ward_no,
            uid
        `;
        const headers = [
          "uid",
          "ward_no",
          "ward_name",
          "first_data_at",
          "last_data_at",
          "reason",
          "total_readings",
          "valid_readings",
          "water_readings",
          "gap_count",
          "max_gap_hours",
          "range_error_count",
          "spike_count",
          "flatline_count",
          "stale_data_days",
          "lat",
          "lng"
        ];
        const csvRows = rows.map(row => [
          row.uid,
          row.ward_no,
          row.ward_name,
          formatExcelDateTime(row.first_data_at),
          formatExcelDateTime(row.last_data_at),
          notUsableReason(row),
          row.total_readings,
          row.valid_readings,
          row.water_readings,
          row.gap_count,
          row.max_gap_hours,
          row.range_error_count,
          row.spike_count,
          row.flatline_count,
          row.stale_data_days,
          row.lat,
          row.lng
        ]);
        return tableExcelResponse(headers, csvRows, "not_usable_sensor_qc_reasons.xlsx", "Not Usable Sensors");
      }

      if (url.pathname === "/api/qc/wards") {
        const rows = await sql`
          SELECT *
          FROM ward_sensor_qc_summary
          ORDER BY
            CASE confidence
              WHEN 'High' THEN 1
              WHEN 'Medium' THEN 2
              ELSE 3
            END,
            avg_qc_score DESC,
            ward_no
        `;

        return json({
          wards: rows.map(row => ({
            wardNo: row.ward_no,
            wardName: row.ward_name,
            sensorCount: row.sensor_count || 0,
            sensorsWithData: row.sensors_with_data || 0,
            goodSensorCount: row.good_sensor_count || 0,
            usableSensorCount: row.usable_sensor_count || 0,
            poorSensorCount: row.poor_sensor_count || 0,
            insufficientSensorCount: row.insufficient_sensor_count || 0,
            noDataSensorCount: row.no_data_sensor_count || 0,
            avgQcScore: row.avg_qc_score || 0,
            confidence: row.confidence || "Low",
            updatedAt: row.updated_at
          })),
          count: rows.length
        });
      }

      if (url.pathname === "/api/population/wards") {
        const rows = await sql`
          SELECT
            ward_no,
            ward_name,
            area_km2,
            population_2001,
            population_2011,
            cagr_2001_2011,
            projected_population_2024,
            projected_population_2026,
            households_2011,
            projected_households_2024,
            imported_at
          FROM ward_population_estimates
          ORDER BY NULLIF(regexp_replace(ward_no, '[^0-9]', '', 'g'), '')::int NULLS LAST, ward_no
        `;

        return json({
          wards: rows.map(row => ({
            wardNo: row.ward_no,
            wardName: row.ward_name,
            areaKm2: row.area_km2,
            population2001: row.population_2001,
            population2011: row.population_2011,
            cagr2001To2011: row.cagr_2001_2011,
            projectedPopulation2024: row.projected_population_2024,
            projectedPopulation2026: row.projected_population_2026,
            households2011: row.households_2011,
            projectedHouseholds2024: row.projected_households_2024,
            importedAt: row.imported_at
          })),
          count: rows.length
        });
      }

      if (url.pathname === "/api/consumption/wards") {
        const rows = await sql`
          WITH latest AS (
            SELECT DISTINCT ON (normalized_ward_name)
              ward_name,
              normalized_ward_name,
              month,
              connections,
              consumption_ml,
              consumption_per_connection
            FROM ward_monthly_consumption
            ORDER BY normalized_ward_name, month DESC
          ),
          summary AS (
            SELECT
              normalized_ward_name,
              MIN(month) AS first_month,
              MAX(month) AS last_month,
              COUNT(*) AS month_count,
              AVG(consumption_ml) AS avg_consumption_ml,
              AVG(consumption_per_connection) AS avg_consumption_per_connection
            FROM ward_monthly_consumption
            GROUP BY normalized_ward_name
          ),
          yearly AS (
            SELECT
              normalized_ward_name,
              SUM(consumption_ml) FILTER (WHERE EXTRACT(YEAR FROM month) = 2025) AS consumption_2025_ml,
              SUM(consumption_ml) FILTER (WHERE EXTRACT(YEAR FROM month) = 2026) AS consumption_2026_ml,
              MAX(connections) FILTER (WHERE EXTRACT(YEAR FROM month) = 2025) AS connections_2025,
              MAX(connections) FILTER (WHERE EXTRACT(YEAR FROM month) = 2026) AS connections_2026,
              SUM(consumption_ml) FILTER (WHERE EXTRACT(YEAR FROM month) = 2025)
                / NULLIF(MAX(connections) FILTER (WHERE EXTRACT(YEAR FROM month) = 2025), 0) AS cpc_2025,
              SUM(consumption_ml) FILTER (WHERE EXTRACT(YEAR FROM month) = 2026)
                / NULLIF(MAX(connections) FILTER (WHERE EXTRACT(YEAR FROM month) = 2026), 0) AS cpc_2026
            FROM ward_monthly_consumption
            GROUP BY normalized_ward_name
          )
          SELECT
            latest.ward_name,
            latest.normalized_ward_name,
            latest.month AS latest_month,
            latest.connections,
            latest.consumption_ml,
            latest.consumption_per_connection,
            summary.first_month,
            summary.last_month,
            summary.month_count,
            summary.avg_consumption_ml,
            summary.avg_consumption_per_connection,
            yearly.consumption_2025_ml,
            yearly.consumption_2026_ml,
            yearly.connections_2025,
            yearly.connections_2026,
            yearly.cpc_2025,
            yearly.cpc_2026
          FROM latest
          JOIN summary USING (normalized_ward_name)
          LEFT JOIN yearly USING (normalized_ward_name)
          ORDER BY latest.ward_name
        `;

        return json({
          wards: rows.map(row => ({
            wardName: row.ward_name,
            normalizedWardName: row.normalized_ward_name,
            latestMonth: row.latest_month,
            connections: row.connections || 0,
            consumptionMl: row.consumption_ml || 0,
            consumptionPerConnection: row.consumption_per_connection || 0,
            firstMonth: row.first_month,
            lastMonth: row.last_month,
            monthCount: row.month_count || 0,
            avgConsumptionMl: row.avg_consumption_ml || 0,
            avgConsumptionPerConnection: row.avg_consumption_per_connection || 0,
            consumption2025Ml: row.consumption_2025_ml,
            consumption2026Ml: row.consumption_2026_ml,
            connections2025: row.connections_2025,
            connections2026: row.connections_2026,
            consumptionPerConnection2025: row.cpc_2025,
            consumptionPerConnection2026: row.cpc_2026
          })),
          count: rows.length
        });
      }

            if (url.pathname === "/api/criticality/wards") {
        const rows = await sql`
          SELECT *
          FROM ward_criticality_summary
          ORDER BY criticality_score DESC, ward_no
        `;

        return json({
          wards: rows.map(row => ({
            wardNo: row.ward_no,
            wardName: row.ward_name,
            qcConfidence: row.qc_confidence,
            usableSensorCount: row.usable_sensor_count || 0,
            avgQcScore: row.avg_qc_score || 0,
            latestConsumptionMl: row.latest_consumption_ml,
            latestConnections: row.latest_connections,
            latestConsumptionPerConnection: row.latest_consumption_per_connection,
            recent90DayRainfallMm: row.recent_90_day_rainfall_mm,
            latestMedianWaterLevelFt: row.latest_median_water_level_ft,
            latestMedianDischargeLpm: row.latest_median_discharge_lpm,
            waterLevelTrendFtPerWeek: row.water_level_trend_ft_per_week,
            waterLevelTrendFtPerMonth: row.water_level_trend_ft_per_month,
            dischargeTrendLpmPerWeek: row.discharge_trend_lpm_per_week,
            dischargeTrendLpmPerMonth: row.discharge_trend_lpm_per_month,
            rainfallResponseFt: row.rainfall_response_ft,
            rainyEventCount: row.rainy_event_count || 0,
            demandScore: row.demand_score || 0,
            groundwaterQcScore: row.groundwater_qc_score || 0,
            rainfallScore: row.rainfall_score || 0,
            depletionScore: row.depletion_score || 0,
            dischargeDeclineScore: row.discharge_decline_score || 0,
            recoveryScore: row.recovery_score || 0,
            criticalityScore: row.criticality_score || 0,
            criticalityStatus: row.criticality_status || "Insufficient Data",
            reasons: Array.isArray(row.reasons) ? row.reasons : [],
            updatedAt: row.updated_at
          })),
          count: rows.length
        });
      }

      if (url.pathname === "/api/criticality/wards.csv") {
        const rows = await sql`
          SELECT *
          FROM ward_criticality_summary
          ORDER BY criticality_score DESC, ward_no
        `;
        const headers = [
          "ward_no",
          "ward_name",
          "criticality_status",
          "criticality_score",
          "qc_confidence",
          "usable_sensor_count",
          "latest_consumption_ml",
          "latest_connections",
          "latest_consumption_per_connection",
          "recent_90_day_rainfall_mm",
          "latest_median_water_level_ft",
          "latest_median_discharge_lpm",
          "water_level_trend_ft_per_week",
          "water_level_trend_ft_per_month",
          "discharge_trend_lpm_per_week",
          "discharge_trend_lpm_per_month",
          "rainfall_response_ft",
          "rainy_event_count",
          "demand_score",
          "depletion_score",
          "discharge_decline_score",
          "recovery_score",
          "rainfall_score",
          "reasons"
        ];
        const csvRows = rows.map(row => [
          row.ward_no,
          row.ward_name,
          row.criticality_status,
          row.criticality_score,
          row.qc_confidence,
          row.usable_sensor_count,
          row.latest_consumption_ml,
          row.latest_connections,
          row.latest_consumption_per_connection,
          row.recent_90_day_rainfall_mm,
          row.latest_median_water_level_ft,
          row.latest_median_discharge_lpm,
          row.water_level_trend_ft_per_week,
          row.water_level_trend_ft_per_month,
          row.discharge_trend_lpm_per_week,
          row.discharge_trend_lpm_per_month,
          row.rainfall_response_ft,
          row.rainy_event_count,
          row.demand_score,
          row.depletion_score,
          row.discharge_decline_score,
          row.recovery_score,
          row.rainfall_score,
          Array.isArray(row.reasons) ? row.reasons.join("; ") : ""
        ]);
        return csvResponse(headers, csvRows, "ward_criticality.csv");
      }

      if (url.pathname === "/api/groundwater-loss/wards.csv") {
        const rows = await sql`
          WITH sensor_uids AS (
            SELECT
              ward_no,
              STRING_AGG(uid, '; ' ORDER BY uid) AS sensor_uids,
              COUNT(*) AS assigned_sensor_count
            FROM sensor_ward_assignments
            WHERE ward_no IS NOT NULL AND ward_no <> ''
            GROUP BY ward_no
          )
          SELECT
            gw.*,
            COALESCE(sensor_uids.sensor_uids, '') AS sensor_uids,
            COALESCE(sensor_uids.assigned_sensor_count, 0) AS assigned_sensor_count
          FROM ward_groundwater_indicators gw
          LEFT JOIN sensor_uids ON sensor_uids.ward_no = gw.ward_no
          WHERE sensor_uids.assigned_sensor_count > 0
          ORDER BY
            water_level_trend_ft_per_month DESC NULLS LAST,
            water_level_trend_ft_per_week DESC NULLS LAST,
            usable_sensor_count DESC,
            ward_no
        `;
        const headers = [
          "rank",
          "ward_no",
          "ward_name",
          "gw_loss_ft_per_week",
          "gw_loss_ft_per_month",
          "sensor_uids",
          "assigned_sensor_count",
          "usable_sensor_count",
          "water_sensor_count",
          "latest_median_water_level_ft",
          "discharge_trend_lpm_per_week",
          "discharge_trend_lpm_per_month",
          "latest_median_discharge_lpm",
          "first_data_at",
          "last_data_at"
        ];
        const csvRows = rows.map((row, index) => [
          index + 1,
          row.ward_no,
          row.ward_name,
          row.water_level_trend_ft_per_week,
          row.water_level_trend_ft_per_month,
          row.sensor_uids,
          row.assigned_sensor_count,
          row.usable_sensor_count,
          row.water_sensor_count,
          row.latest_median_water_level_ft,
          row.discharge_trend_lpm_per_week,
          row.discharge_trend_lpm_per_month,
          row.latest_median_discharge_lpm,
          row.first_data_at,
          row.last_data_at
        ]);
        return csvResponse(headers, csvRows, "groundwater_loss_ward_ranking.csv");
      }

      if (
        url.pathname === "/api/good-sensor-weekly-start-levels.xlsx"
        || url.pathname === "/api/good-sensor-weekly-start-levels.xls"
        || url.pathname === "/api/good-sensor-weekly-start-levels.csv"
      ) {
        const rows = await sql`
          WITH good_sensors AS (
            SELECT uid, ward_no, ward_name, qc_status
            FROM sensor_qc_summary
            WHERE qc_status = 'GOOD'
              AND ward_no IS NOT NULL
              AND ward_no <> ''
          ),
          uploaded_uids AS (
            SELECT DISTINCT uid FROM uploaded_type_b_sessions
          ),
          type_b_points AS (
            SELECT
              q.ward_no,
              q.ward_name,
              q.uid,
              q.qc_status,
              b.start_time AS time,
              b.water_level_start_ft AS water_level_ft
            FROM uploaded_type_b_sessions b
            JOIN good_sensors q ON q.uid = b.uid
            WHERE b.water_level_start_ft IS NOT NULL
            UNION ALL
            SELECT
              q.ward_no,
              q.ward_name,
              q.uid,
              q.qc_status,
              b.stop_time AS time,
              b.water_level_stop_ft AS water_level_ft
            FROM uploaded_type_b_sessions b
            JOIN good_sensors q ON q.uid = b.uid
            WHERE b.water_level_stop_ft IS NOT NULL
          ),
          kh_points AS (
            SELECT
              q.ward_no,
              q.ward_name,
              q.uid,
              q.qc_status,
              w.time,
              COALESCE(w.water_level, w.on_level, w.off_level) AS water_level_ft
            FROM water_levels w
            JOIN good_sensors q ON q.uid = w.uid
            WHERE q.uid NOT IN (SELECT uid FROM uploaded_uids)
              AND COALESCE(w.water_level, w.on_level, w.off_level) IS NOT NULL
          ),
          points AS (
            SELECT * FROM type_b_points
            UNION ALL
            SELECT * FROM kh_points
          ),
          keyed AS (
            SELECT
              ward_no,
              ward_name,
              uid,
              qc_status,
              EXTRACT(YEAR FROM time)::integer AS year,
              EXTRACT(MONTH FROM time)::integer AS month_number,
              TO_CHAR(DATE_TRUNC('month', time), 'YYYY-MM Mon') AS month,
              LEAST((((EXTRACT(DAY FROM time)::integer - 1) / 7) + 1), 4)::integer AS week_number,
              time AS reading_time,
              water_level_ft
            FROM points
          ),
          first_readings AS (
            SELECT *,
              ROW_NUMBER() OVER (
                PARTITION BY uid, year, month_number, week_number
                ORDER BY reading_time ASC
              ) AS reading_rank
            FROM keyed
          )
          SELECT
            ward_no,
            ward_name,
            uid,
            qc_status,
            year,
            month_number,
            month,
            MAX(water_level_ft) FILTER (WHERE week_number = 1) AS week_1_start_water_level_ft,
            MAX(reading_time) FILTER (WHERE week_number = 1) AS week_1_reading_time,
            MAX(water_level_ft) FILTER (WHERE week_number = 2) AS week_2_start_water_level_ft,
            MAX(reading_time) FILTER (WHERE week_number = 2) AS week_2_reading_time,
            MAX(water_level_ft) FILTER (WHERE week_number = 3) AS week_3_start_water_level_ft,
            MAX(reading_time) FILTER (WHERE week_number = 3) AS week_3_reading_time,
            MAX(water_level_ft) FILTER (WHERE week_number = 4) AS week_4_start_water_level_ft,
            MAX(reading_time) FILTER (WHERE week_number = 4) AS week_4_reading_time
          FROM first_readings
          WHERE reading_rank = 1
          GROUP BY ward_no, ward_name, uid, qc_status, year, month_number, month
          ORDER BY year DESC, month_number DESC, ward_no, ward_name, uid
        `;

        return weeklyLevelsExcelResponse(rows, "good_sensor_weekly_start_levels.xlsx");
      }

      if (url.pathname === "/api/ward-weekly-levels") {
        const wardNo = url.searchParams.get("ward_no");
        const qcRows = wardNo ? await sql`
          SELECT uid, ward_no, ward_name, qc_status
          FROM sensor_qc_summary
          WHERE ward_no = ${wardNo}
        ` : await sql`
          SELECT uid, ward_no, ward_name, qc_status
          FROM sensor_qc_summary
          WHERE ward_no IS NOT NULL
            AND ward_no <> ''
        `;
        const rows = wardNo ? await sql`
          WITH good_sensors AS (
            SELECT uid, ward_no, ward_name
            FROM sensor_qc_summary
            WHERE qc_status = 'GOOD'
              AND ward_no = ${wardNo}
          ),
          uploaded_uids AS (
            SELECT DISTINCT uid FROM uploaded_type_b_sessions
          ),
          type_b_points AS (
            SELECT q.ward_no, q.ward_name, q.uid, b.start_time AS time, b.water_level_start_ft AS water_level_ft
            FROM uploaded_type_b_sessions b
            JOIN good_sensors q ON q.uid = b.uid
            WHERE b.water_level_start_ft IS NOT NULL
            UNION ALL
            SELECT q.ward_no, q.ward_name, q.uid, b.stop_time AS time, b.water_level_stop_ft AS water_level_ft
            FROM uploaded_type_b_sessions b
            JOIN good_sensors q ON q.uid = b.uid
            WHERE b.water_level_stop_ft IS NOT NULL
          ),
          kh_points AS (
            SELECT q.ward_no, q.ward_name, q.uid, w.time, COALESCE(w.water_level, w.on_level, w.off_level) AS water_level_ft
            FROM water_levels w
            JOIN good_sensors q ON q.uid = w.uid
            WHERE q.uid NOT IN (SELECT uid FROM uploaded_uids)
              AND COALESCE(w.water_level, w.on_level, w.off_level) IS NOT NULL
          ),
          keyed AS (
            SELECT
              ward_no,
              ward_name,
              uid,
              EXTRACT(YEAR FROM time)::integer AS year,
              EXTRACT(MONTH FROM time)::integer AS month_number,
              LEAST((((EXTRACT(DAY FROM time)::integer - 1) / 7) + 1), 4)::integer AS week_number,
              time AS reading_time,
              water_level_ft
            FROM (
              SELECT * FROM type_b_points
              UNION ALL
              SELECT * FROM kh_points
            ) points
            WHERE time >= DATE '2026-01-01'
          ),
          first_readings AS (
            SELECT *,
              ROW_NUMBER() OVER (
                PARTITION BY uid, year, month_number, week_number
                ORDER BY reading_time ASC
              ) AS reading_rank
            FROM keyed
          )
          SELECT ward_no, ward_name, uid, year, month_number, week_number, reading_time, water_level_ft
          FROM first_readings
          WHERE reading_rank = 1
          ORDER BY year, month_number, week_number, ward_no, uid
        ` : await sql`
          WITH good_sensors AS (
            SELECT uid, ward_no, ward_name
            FROM sensor_qc_summary
            WHERE qc_status = 'GOOD'
              AND ward_no IS NOT NULL
              AND ward_no <> ''
          ),
          uploaded_uids AS (
            SELECT DISTINCT uid FROM uploaded_type_b_sessions
          ),
          type_b_points AS (
            SELECT q.ward_no, q.ward_name, q.uid, b.start_time AS time, b.water_level_start_ft AS water_level_ft
            FROM uploaded_type_b_sessions b
            JOIN good_sensors q ON q.uid = b.uid
            WHERE b.water_level_start_ft IS NOT NULL
            UNION ALL
            SELECT q.ward_no, q.ward_name, q.uid, b.stop_time AS time, b.water_level_stop_ft AS water_level_ft
            FROM uploaded_type_b_sessions b
            JOIN good_sensors q ON q.uid = b.uid
            WHERE b.water_level_stop_ft IS NOT NULL
          ),
          kh_points AS (
            SELECT q.ward_no, q.ward_name, q.uid, w.time, COALESCE(w.water_level, w.on_level, w.off_level) AS water_level_ft
            FROM water_levels w
            JOIN good_sensors q ON q.uid = w.uid
            WHERE q.uid NOT IN (SELECT uid FROM uploaded_uids)
              AND COALESCE(w.water_level, w.on_level, w.off_level) IS NOT NULL
          ),
          keyed AS (
            SELECT
              ward_no,
              ward_name,
              uid,
              EXTRACT(YEAR FROM time)::integer AS year,
              EXTRACT(MONTH FROM time)::integer AS month_number,
              LEAST((((EXTRACT(DAY FROM time)::integer - 1) / 7) + 1), 4)::integer AS week_number,
              time AS reading_time,
              water_level_ft
            FROM (
              SELECT * FROM type_b_points
              UNION ALL
              SELECT * FROM kh_points
            ) points
            WHERE time >= DATE '2026-01-01'
          ),
          first_readings AS (
            SELECT *,
              ROW_NUMBER() OVER (
                PARTITION BY uid, year, month_number, week_number
                ORDER BY reading_time ASC
              ) AS reading_rank
            FROM keyed
          )
          SELECT ward_no, ward_name, uid, year, month_number, week_number, reading_time, water_level_ft
          FROM first_readings
          WHERE reading_rank = 1
          ORDER BY year, month_number, week_number, ward_no, uid
        `;

        const payload = weeklyWardPayload(rows, qcRows);
        return json(wardNo ? {
          ward: payload.wards.find(ward => String(ward.wardNo) === String(wardNo)) || null,
          weeks: payload.weeks
        } : payload);
      }

      if (url.pathname === "/api/indicators/wards") {
        const rows = await sql`
          WITH recent_rainfall AS (
            SELECT
              ward_no,
              SUM(rainfall_mm) AS recent_90_day_rainfall_mm
            FROM ward_daily_rainfall
            WHERE date >= CURRENT_DATE - INTERVAL '90 days'
              AND source = 'CHIRPS'
            GROUP BY ward_no
          )
          SELECT
            gw.*,
            recent_rainfall.recent_90_day_rainfall_mm
          FROM ward_groundwater_indicators gw
          LEFT JOIN recent_rainfall ON recent_rainfall.ward_no = gw.ward_no
          ORDER BY gw.ward_no
        `;

        return json({
          wards: rows.map(row => ({
            wardNo: row.ward_no,
            wardName: row.ward_name,
            usableSensorCount: row.usable_sensor_count || 0,
            waterSensorCount: row.water_sensor_count || 0,
            dischargeSensorCount: row.discharge_sensor_count || 0,
            latestMedianWaterLevelFt: row.latest_median_water_level_ft,
            latestMedianDischargeLpm: row.latest_median_discharge_lpm,
            waterLevelTrendFtPerWeek: row.water_level_trend_ft_per_week,
            waterLevelTrendFtPerMonth: row.water_level_trend_ft_per_month,
            dischargeTrendLpmPerWeek: row.discharge_trend_lpm_per_week,
            dischargeTrendLpmPerMonth: row.discharge_trend_lpm_per_month,
            recent90DayRainfallMm: row.recent_90_day_rainfall_mm,
            rainfallResponseFt: row.rainfall_response_ft,
            rainyEventCount: row.rainy_event_count || 0,
            firstDataAt: row.first_data_at,
            lastDataAt: row.last_data_at,
            updatedAt: row.updated_at
          })),
          count: rows.length
        });
      }

      if (url.pathname === "/api/water-level") {
        const uid = url.searchParams.get("uid");
        if (!uid) return json({ error: "uid is required" }, 400);

        await ensureCompactUploadTable(sql);
        const compactRows = await sql`
          SELECT payload_gzip
          FROM uploaded_sensor_series
          WHERE uid = ${uid}
          LIMIT 1
        `;

        if (compactRows.length) {
          const points = await gunzipJson(compactRows[0].payload_gzip);
          return json({
            uid,
            source: "uploaded_compact",
            points
          });
        }

        await ensureUploadedTables(sql);
        const uploaded = await sql`
          WITH type_b_points AS (
            SELECT start_time AS time, water_level_start_ft AS water_level, NULL::double precision AS on_level,
                   water_level_start_ft AS off_level, NULL::double precision AS discharge
            FROM uploaded_type_b_sessions
            WHERE uid = ${uid}
            UNION ALL
            SELECT stop_time AS time, water_level_stop_ft AS water_level, water_level_stop_ft AS on_level,
                   NULL::double precision AS off_level, NULL::double precision AS discharge
            FROM uploaded_type_b_sessions
            WHERE uid = ${uid}
          ),
          type_a_points AS (
            SELECT time, NULL::double precision AS water_level, NULL::double precision AS on_level,
                   NULL::double precision AS off_level, discharge
            FROM uploaded_type_a_readings
            WHERE uid = ${uid}
          )
          SELECT time, MAX(water_level) AS water_level, MAX(on_level) AS on_level,
                 MAX(off_level) AS off_level, MAX(discharge) AS discharge
          FROM (
            SELECT * FROM type_b_points
            UNION ALL
            SELECT * FROM type_a_points
          ) points
          GROUP BY time
          ORDER BY time
        `;

        const rows = uploaded.length ? uploaded : await sql`
          SELECT time, water_level, on_level, off_level, discharge
          FROM water_levels
          WHERE uid = ${uid}
          ORDER BY time
        `;

        return json({
          uid,
          source: uploaded.length ? "uploaded" : "kh_download",
          points: rows.map(row => ({
            time: row.time,
            waterLevel: row.water_level,
            onLevel: row.on_level,
            offLevel: row.off_level,
            discharge: row.discharge
          }))
        });
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (isMissingRelation(error)) {
        if (url.pathname === "/api/status") {
          return json(statusPayload({ running: false, ok: null, message: "Database is not initialized yet" }));
        }

        if (url.pathname === "/api/refresh") {
          await triggerGithubAction(env);
          return json({ started: true, reason: "database_not_initialized" });
        }

        if (url.pathname === "/api/sensors") {
          return json({ sensors: [], sensorsWithWaterData: 0 });
        }

        if (url.pathname === "/api/qc/sensors") {
          return json({ sensors: [], count: 0 });
        }

        if (url.pathname === "/api/qc/wards") {
          return json({ wards: [], count: 0 });
        }

        if (url.pathname === "/api/ward-weekly-levels") {
          return json(url.searchParams.get("ward_no") ? { ward: null, weeks: [] } : { wards: [], weeks: [] });
        }

        if (url.pathname === "/api/population/wards") {
          return json({ wards: [], count: 0 });
        }

        if (url.pathname === "/api/water-level") {
          return json({ uid: url.searchParams.get("uid") || "", points: [] });
        }
      }

      return json({ error: String(error.message || error) }, 500);
    }
  }
};
