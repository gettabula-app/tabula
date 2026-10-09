/** Remove SQL comments and single-quoted values while preserving token boundaries. */
function withoutCommentsAndStrings(sql) {
  let out = '';
  for (let i = 0; i < sql.length;) {
    if (sql[i] === "'" ) {
      out += ' ';
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          out += sql[i] === '\n' ? '\n' : ' ';
          i++;
        }
      }
      continue;
    }
    if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql[i] === '\n' ? '\n' : ' ';
        i++;
      }
      i = Math.min(sql.length, i + 2);
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}

/**
 * Return short reasons a migration may prevent an older build from reading or writing its database.
 * This is a review aid, not a SQL parser: ambiguous data-changing statements are treated as breaking.
 * @param {string} sql
 * @returns {string[]}
 */
export function lintMigration(sql) {
  const clean = withoutCommentsAndStrings(sql);
  const reasons = [];
  const statements = clean.split(';').map((statement) => statement.trim()).filter(Boolean);

  if (/\bDROP\s+(?:TABLE|COLUMN|INDEX|TRIGGER|VIEW)\b/i.test(clean)) reasons.push('DROP removes a database object');
  if (statements.some((statement) => /^ALTER\s+TABLE\b[\s\S]*\bRENAME\s+(?:TO|COLUMN)\b/i.test(statement))) {
    reasons.push('ALTER TABLE RENAME changes a name older code may use');
  }
  if (statements.some((statement) => {
    if (!/^ALTER\s+TABLE\b/i.test(statement)) return false;
    const add = /\bADD\s+(?:COLUMN\s+)?([\s\S]*)/i.exec(statement);
    return Boolean(add && /\bNOT\s+NULL\b/i.test(add[1]) && !/\bDEFAULT\b/i.test(add[1]));
  })) {
    reasons.push('NOT NULL column without a DEFAULT rejects older inserts');
  }
  if (/\bCREATE\s+UNIQUE\s+INDEX\b/i.test(clean)) reasons.push('CREATE UNIQUE INDEX can reject older writes');
  if (/\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(clean)) reasons.push('CREATE TRIGGER changes database write behavior');
  if (statements.some((statement) => /^UPDATE\b/i.test(statement))) reasons.push('UPDATE rewrites existing data');
  if (statements.some((statement) => /^DELETE\s+FROM\b/i.test(statement))) reasons.push('DELETE FROM removes existing data');
  if (/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\w$-]+_new\b[\s\S]*?\bINSERT\s+INTO\b[\s\S]*?\bSELECT\b[\s\S]*?\bDROP\s+TABLE\b[\s\S]*?\bALTER\s+TABLE\b[\s\S]*?\bRENAME\s+TO\b/i.test(clean)) {
    reasons.push('table rebuild is always breaking, including CHECK changes');
  }
  return reasons;
}
