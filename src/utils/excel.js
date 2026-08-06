import {
  FT_TO_M,
  LPM_TO_M3_PER_SEC,
  TRANSMISSIVITY_SCALE,
  MIN_MONTHLY_DRAWDOWN_M,
  PREVIOUS_CRITICAL_WARDS,
  CRITICAL_GW_MIN_WEEKS,
  CRITICAL_GW_MIN_COMPARISONS,
  CRITICAL_GW_MAX_WEEK_GAP,
  CRITICAL_GW_MIN_LARGE_JUMP_FT,
  CRITICAL_GW_RELATIVE_JUMP_RATIO,
  CRITICAL_GW_DECLINE_FT_PER_WEEK,
  TREND_SIGNIFICANCE_ALPHA
} from "../config/constants.js";
import { xmlEscape } from "./response.js";
import { makeZip } from "./zip.js";
import {
  monthLabel,
  formatExcelDateTime,
  datePart,
  monthLabelFromDatePart,
  dayLabelFromDatePart
} from "./date.js";
import {
  roundNumber,
  percentile
} from "./math.js";
import {
  normalizeWardNoValue,
  criticalWardMap,
  weeklyWardPayload
} from "./data-cleaning.js";

export function waterLevelCell(value) {
  if (value === null || value === undefined || value === "") return "";
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.round(numberValue * 100) / 100 : value;
}

export function columnName(index) {
  let name = "";
  while (index > 0) {
    const remainder = (index - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    index = Math.floor((index - 1) / 26);
  }
  return name;
}

export function cellAddress(row, column) {
  return `${columnName(column)}${row}`;
}

export function inlineCell(row, column, value, style = 3) {
  if (value === null || value === undefined || value === "") return "";
  return `<c r="${cellAddress(row, column)}" s="${style}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
}

export function numberCell(row, column, value, style = 4) {
  if (value === null || value === undefined || value === "") return "";
  return `<c r="${cellAddress(row, column)}" s="${style}"><v>${xmlEscape(value)}</v></c>`;
}

export function formulaCell(row, column, formula, value, style = 3) {
  return `<c r="${cellAddress(row, column)}" s="${style}"><f>${xmlEscape(formula)}</f><v>${xmlEscape(value ?? "")}</v></c>`;
}

export function safeExcelSheetName(value, fallback = "Sheet") {
  const cleaned = String(value || fallback)
    .replace(/[\[\]:*?/\\]/g, "_")
    .slice(0, 31);
  return cleaned || fallback;
}

export function tableExcelResponse(headers, rows, filename, sheetName = "Sheet1") {
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

export function multiSheetExcelResponse(sheets, filename) {
  const usedNames = new Set();
  const normalizedSheets = sheets.map((sheet, index) => {
    const baseName = safeExcelSheetName(sheet.name, `Sheet${index + 1}`);
    let name = baseName;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = `${baseName.slice(0, 28)}_${suffix}`;
      suffix += 1;
    }
    usedNames.add(name);
    return { ...sheet, name };
  });

  const worksheetXml = (sheet) => {
    const headers = sheet.headers || [];
    const headerRows = sheet.headerRows || [headers];
    const rows = sheet.rows || [];
    const preambleRows = sheet.preambleRows || [];
    const merges = sheet.merges || [];
    const sheetRows = [];

    preambleRows.forEach((row, rowIndex) => {
      const excelRow = rowIndex + 1;
      const cells = row.map((value, colIndex) => {
        if (value && typeof value === "object" && value.formula) {
          return formulaCell(excelRow, colIndex + 1, value.formula, value.value, 3);
        }
        return inlineCell(excelRow, colIndex + 1, value, 3);
      });
      sheetRows.push(`<row r="${excelRow}">${cells.join("")}</row>`);
    });

    const headerRow = preambleRows.length + 1;
    headerRows.forEach((headerValues, headerIndex) => {
      const excelRow = headerRow + headerIndex;
      sheetRows.push(`<row r="${excelRow}">${(headerValues || []).map((header, index) => inlineCell(excelRow, index + 1, header, 2)).join("")}</row>`);
    });

    rows.forEach((row, rowIndex) => {
      const excelRow = headerRow + headerRows.length + rowIndex;
      const cells = row.map((value, colIndex) => {
        if (value && typeof value === "object" && value.formula) {
          return formulaCell(excelRow, colIndex + 1, value.formula, value.value, 3);
        }
        if (typeof value === "number" && Number.isFinite(value)) {
          return numberCell(excelRow, colIndex + 1, value, 4);
        }
        return inlineCell(excelRow, colIndex + 1, value, 3);
      });
      sheetRows.push(`<row r="${excelRow}">${cells.join("")}</row>`);
    });

    const maxColumn = Math.max(
      ...headerRows.map(row => (row || []).length),
      ...rows.map(row => (row || []).length),
      headers.length,
      1
    );
    const maxRow = Math.max(preambleRows.length + rows.length + headerRows.length, 1);
    const cols = `<col min="1" max="${maxColumn}" width="20" customWidth="1"/>`;
    const mergeXml = merges.length
      ? `<mergeCells count="${merges.length}">${merges.map(ref => `<mergeCell ref="${xmlEscape(ref)}"/>`).join("")}</mergeCells>`
      : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:${cellAddress(maxRow, maxColumn)}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow + headerRows.length - 1}" topLeftCell="A${headerRow + headerRows.length}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${cols}</cols>
  <sheetData>${sheetRows.join("")}</sheetData>
  ${mergeXml}
</worksheet>`;
  };

  const workbookSheets = normalizedSheets.map((sheet, index) =>
    `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
  ).join("");

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${workbookSheets}</sheets>
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

  const contentTypeOverrides = normalizedSheets.map((_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join("");
  const workbookRels = normalizedSheets.map((_, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  ).join("");

  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${contentTypeOverrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    },
    { name: "xl/workbook.xml", data: workbook },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRels}<Relationship Id="rId${normalizedSheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    },
    { name: "xl/styles.xml", data: styles },
    ...normalizedSheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: worksheetXml(sheet)
    }))
  ];

  return new Response(makeZip(files), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "access-control-allow-origin": "*"
    }
  });
}

export function weeklyLevelsExcelResponse(rows, filename) {
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
