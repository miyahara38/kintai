'use strict';
// Excel(.xlsx)作成。既存の「残業管理システム_スマホ版.html」の出力コードをそのまま移植(外部ライブラリなし)。
// 変更点: 数式として解釈されうる文字(= + - @ など)で始まる文字列は、先頭に ' を付けて文字列として扱う。
const XLSX_CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function xlsxCrc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = XLSX_CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function xlsxToUtf8(str) { return new TextEncoder().encode(str); }

function xlsxDosDateTime(d) {
    const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1F);
    const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    return { time: time & 0xFFFF, date: date & 0xFFFF };
}

class XlsxByteWriter {
    constructor() { this.chunks = []; this.length = 0; }
    u16(v) { this.chunks.push(Uint8Array.of(v & 0xFF, (v >>> 8) & 0xFF)); this.length += 2; }
    u32(v) { this.chunks.push(Uint8Array.of(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF)); this.length += 4; }
    bytes(arr) { this.chunks.push(arr); this.length += arr.length; }
    toUint8Array() {
        const out = new Uint8Array(this.length);
        let offset = 0;
        for (const c of this.chunks) { out.set(c, offset); offset += c.length; }
        return out;
    }
}

function xlsxBuildZip(files) {
    const { time, date } = xlsxDosDateTime(new Date());
    const localWriter = new XlsxByteWriter();
    const centralWriter = new XlsxByteWriter();

    for (const file of files) {
        const nameBytes = xlsxToUtf8(file.name);
        const data = file.data;
        const crc = xlsxCrc32(data);
        const localOffset = localWriter.length;

        localWriter.u32(0x04034b50); localWriter.u16(20); localWriter.u16(0); localWriter.u16(0);
        localWriter.u16(time); localWriter.u16(date); localWriter.u32(crc);
        localWriter.u32(data.length); localWriter.u32(data.length);
        localWriter.u16(nameBytes.length); localWriter.u16(0);
        localWriter.bytes(nameBytes); localWriter.bytes(data);

        centralWriter.u32(0x02014b50); centralWriter.u16(20); centralWriter.u16(20);
        centralWriter.u16(0); centralWriter.u16(0); centralWriter.u16(time); centralWriter.u16(date);
        centralWriter.u32(crc); centralWriter.u32(data.length); centralWriter.u32(data.length);
        centralWriter.u16(nameBytes.length); centralWriter.u16(0); centralWriter.u16(0);
        centralWriter.u16(0); centralWriter.u16(0); centralWriter.u32(0); centralWriter.u32(localOffset);
        centralWriter.bytes(nameBytes);
    }

    const centralOffset = localWriter.length;
    const centralSize = centralWriter.length;
    const eocd = new XlsxByteWriter();
    eocd.u32(0x06054b50); eocd.u16(0); eocd.u16(0);
    eocd.u16(files.length); eocd.u16(files.length);
    eocd.u32(centralSize); eocd.u32(centralOffset); eocd.u16(0);

    const finalWriter = new XlsxByteWriter();
    finalWriter.bytes(localWriter.toUint8Array());
    finalWriter.bytes(centralWriter.toUint8Array());
    finalWriter.bytes(eocd.toUint8Array());
    return finalWriter.toUint8Array();
}

function xlsxEscapeXml(value) {
    return String(value ?? "")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// 数式インジェクション対策: 先頭が = + - @ タブ 改行 の文字列は ' を前置する
function xlsxNeutralize(v) {
  const t = String(v ?? '');
  return /^[=+\-@\t\r\n]/.test(t) ? "'" + t : t;
}

function xlsxColName(index) {
    let n = index + 1;
    let s = "";
    while (n > 0) {
        const rem = (n - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

function xlsxCellRef(rowNum, colIndex) { return `${xlsxColName(colIndex)}${rowNum}`; }

function xlsxDisplayWidth(value) {
    let width = 0;
    for (const ch of String(value ?? "")) {
        const cp = ch.codePointAt(0);
        const isWide = (
            (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0xA4CF) ||
            (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) ||
            (cp >= 0xFF00 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6)
        );
        width += isWide ? 2 : 1;
    }
    return width;
}

function xlsxEstimateWrappedLines(value, colWidth) {
    const text = String(value ?? "");
    if (!text) return 1;
    const usablePerLine = Math.max(4, colWidth - 2);
    return Math.max(1, Math.ceil(xlsxDisplayWidth(text) / usablePerLine));
}

function xlsxEstimateRowHeight(values, columns, minHeight) {
    let maxLines = 1;
    values.forEach((v, i) => {
        const w = (columns[i] && columns[i].width) || 10;
        maxLines = Math.max(maxLines, xlsxEstimateWrappedLines(v, w));
    });
    return Math.max(minHeight, maxLines * 14 + 6);
}

function xlsxBuildStylesXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="176" formatCode="#,##0" /></numFmts>
  <fonts count="6">
<font><sz val="10.5"/><name val="游ゴシック"/><family val="2"/></font>
<font><b/><sz val="16"/><color rgb="FF1E293B"/><name val="游ゴシック"/><family val="2"/></font>
<font><i/><sz val="9"/><color rgb="FF64748B"/><name val="游ゴシック"/><family val="2"/></font>
<font><b/><sz val="10.5"/><color rgb="FFFFFFFF"/><name val="游ゴシック"/><family val="2"/></font>
<font><sz val="10.5"/><color rgb="FF334155"/><name val="游ゴシック"/><family val="2"/></font>
<font><b/><sz val="10.5"/><color rgb="FF78350F"/><name val="游ゴシック"/><family val="2"/></font>
  </fonts>
  <fills count="6">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1E293B"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFDE68A"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFFBEB"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border>
  <left style="thin"><color rgb="FFCBD5E1"/></left>
  <right style="thin"><color rgb="FFCBD5E1"/></right>
  <top style="thin"><color rgb="FFCBD5E1"/></top>
  <bottom style="thin"><color rgb="FFCBD5E1"/></bottom>
  <diagonal/>
</border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="13">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="176" fontId="4" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="176" fontId="4" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="0" fontId="5" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="5" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="176" fontId="5" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

const XLSX_STYLE = {
    TITLE: 1, SUBTITLE: 2, HEADER: 3,
    TEXT: 4, TEXT_ALT: 5, CENTER: 6, CENTER_ALT: 7,
    NUM: 8, NUM_ALT: 9,
    SUMMARY_HEADER: 10, SUMMARY_TEXT: 11, SUMMARY_NUM: 12
};

function xlsxRow(rowNum, values, styles, height, numericFlags) {
    const cells = values.map((v, i) => {
        const style = styles[i] ?? 0;
        const ref = xlsxCellRef(rowNum, i);
        const isNumeric = numericFlags ? numericFlags[i] : false;
        if (isNumeric && v !== "" && v !== null && v !== undefined && !Number.isNaN(Number(v))) {
            return `<c r="${ref}" s="${style}"><v>${Number(v)}</v></c>`;
        }
        return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xlsxEscapeXml(xlsxNeutralize(v))}</t></is></c>`;
    }).join("");
    const heightAttr = height ? ` ht="${height}" customHeight="1"` : "";
    return `<row r="${rowNum}"${heightAttr}>${cells}</row>`;
}

function xlsxBuildSheetXml(def) {
    const colCount = def.columns.length;
    const TITLE_ROW = 1, SUBTITLE_ROW = 2, HEADER_ROW = 4;
    const dataStartRow = HEADER_ROW + 1;
    const dataEndRow = dataStartRow + def.rows.length - 1;
    const rowsXml = [];
    const merges = [];

    merges.push(`A${TITLE_ROW}:${xlsxColName(colCount - 1)}${TITLE_ROW}`);
    rowsXml.push(xlsxRow(TITLE_ROW, [def.title], [XLSX_STYLE.TITLE], 24));
    merges.push(`A${SUBTITLE_ROW}:${xlsxColName(colCount - 1)}${SUBTITLE_ROW}`);
    rowsXml.push(xlsxRow(SUBTITLE_ROW, [def.subtitle || ""], [XLSX_STYLE.SUBTITLE], 16));
    rowsXml.push(`<row r="3" ht="6" customHeight="1"></row>`);
    rowsXml.push(xlsxRow(HEADER_ROW, def.columns.map(c => c.header), def.columns.map(() => XLSX_STYLE.HEADER), 22));

    def.rows.forEach((row, i) => {
        const rowNum = dataStartRow + i;
        const alt = i % 2 === 1;
        const styles = def.columns.map(c => {
            if (c.numeric) return alt ? XLSX_STYLE.NUM_ALT : XLSX_STYLE.NUM;
            if (c.align === "center") return alt ? XLSX_STYLE.CENTER_ALT : XLSX_STYLE.CENTER;
            return alt ? XLSX_STYLE.TEXT_ALT : XLSX_STYLE.TEXT;
        });
        rowsXml.push(xlsxRow(rowNum, row, styles, xlsxEstimateRowHeight(row, def.columns, 18), def.columns.map(c => !!c.numeric)));
    });

    let nextRow = dataEndRow + 1;
    if (def.rows.length === 0) {
        merges.push(`A${dataStartRow}:${xlsxColName(colCount - 1)}${dataStartRow}`);
        rowsXml.push(xlsxRow(dataStartRow, ["対象データがありません"], [XLSX_STYLE.TEXT], 18));
        nextRow = dataStartRow + 1;
    }

    if (def.summary) {
        nextRow += 1;
        const sColCount = def.summary.columns.length;
        const summaryFullWidthCol = { width: def.columns.slice(0, Math.max(colCount, sColCount)).reduce((sum, c) => sum + (c ? c.width : 10), 0) };
        merges.push(`A${nextRow}:${xlsxColName(Math.max(colCount, sColCount) - 1)}${nextRow}`);
        rowsXml.push(xlsxRow(nextRow, [def.summary.label], [XLSX_STYLE.SUMMARY_HEADER], xlsxEstimateRowHeight([def.summary.label], [summaryFullWidthCol], 20)));
        nextRow += 1;
        rowsXml.push(xlsxRow(nextRow, def.summary.columns.map(c => c.header), def.summary.columns.map(() => XLSX_STYLE.SUMMARY_HEADER),
            xlsxEstimateRowHeight(def.summary.columns.map(c => c.header), def.summary.columns, 20)));
        nextRow += 1;
        def.summary.rows.forEach(row => {
            const styles = def.summary.columns.map(c => c.numeric ? XLSX_STYLE.SUMMARY_NUM : XLSX_STYLE.SUMMARY_TEXT);
            rowsXml.push(xlsxRow(nextRow, row, styles, xlsxEstimateRowHeight(row, def.summary.columns, 20), def.summary.columns.map(c => !!c.numeric)));
            nextRow += 1;
        });
    }

    const lastRow = nextRow - 1;
    const colsXml = `<cols>${def.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join("")}</cols>`;
    const dimensionRef = `A1:${xlsxColName(colCount - 1)}${lastRow}`;
    const autoFilterRef = def.rows.length > 0 ? `A${HEADER_ROW}:${xlsxColName(colCount - 1)}${HEADER_ROW}` : null;

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
  <dimension ref="${dimensionRef}"/>
  <sheetViews>
<sheetView showGridLines="0" workbookViewId="0">
  <pane ySplit="${HEADER_ROW}" topLeftCell="A${dataStartRow}" activePane="bottomLeft" state="frozen"/>
</sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="16"/>
  ${colsXml}
  <sheetData>
${rowsXml.join("\n    ")}
  </sheetData>
  ${autoFilterRef ? `<autoFilter ref="${autoFilterRef}"/>` : ""}
  ${merges.length ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : ""}
  <printOptions horizontalCentered="1"/>
  <pageMargins left="0.3" right="0.3" top="0.5" bottom="0.4" header="0.2" footer="0.2"/>
  <pageSetup paperSize="9" scale="100" fitToWidth="1" fitToHeight="0" orientation="landscape" horizontalDpi="300" verticalDpi="300"/>
  <headerFooter differentFirst="0" differentOddEven="0">
<oddFooter>&amp;C&amp;P / &amp;N ページ</oddFooter>
  </headerFooter>
</worksheet>`;
}

function xlsxContentTypesXml(sheetCount) {
    const overrides = [];
    for (let i = 1; i <= sheetCount; i++) {
        overrides.push(`<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    }
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${overrides.join("\n  ")}
</Types>`;
}

function xlsxRootRelsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

function xlsxWorkbookXml(sheets) {
    const sheetEls = sheets.map((s, i) => `<sheet name="${xlsxEscapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
    const definedNames = sheets.map((s, i) =>
        `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">'${xlsxEscapeXml(s.name)}'!$1:$4</definedName>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <fileVersion appName="xl"/>
  <workbookPr/>
  <sheets>${sheetEls}</sheets>
  <definedNames>${definedNames}</definedNames>
</workbook>`;
}

function xlsxWorkbookRelsXml(sheets) {
    const rels = sheets.map((s, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${rels}
  <Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function xlsxBuildWorkbook(sheets) {
    const files = [
        { name: "[Content_Types].xml", data: xlsxToUtf8(xlsxContentTypesXml(sheets.length)) },
        { name: "_rels/.rels", data: xlsxToUtf8(xlsxRootRelsXml()) },
        { name: "xl/workbook.xml", data: xlsxToUtf8(xlsxWorkbookXml(sheets)) },
        { name: "xl/_rels/workbook.xml.rels", data: xlsxToUtf8(xlsxWorkbookRelsXml(sheets)) },
        { name: "xl/styles.xml", data: xlsxToUtf8(xlsxBuildStylesXml()) }
    ];
    sheets.forEach((sheet, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xlsxToUtf8(xlsxBuildSheetXml(sheet.def)) }));
    return xlsxBuildZip(files);
}
module.exports = { xlsxBuildWorkbook };
