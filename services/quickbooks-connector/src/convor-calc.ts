// Convor: exact decimal arithmetic for the finance assistant, so totals,
// differences, percentages and ratios never come from a language model's
// mental math. Supports + - * / and parentheses on decimal numbers.
// Uses BigInt fixed-point arithmetic (no floating point, no eval).

const DIV_SCALE = 30; // digits kept after the decimal point when dividing

class Dec {
  constructor(readonly n: bigint, readonly s: number) {}
  static parse(text: string): Dec {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
    if (!m) throw new Error(`not a number: ${text}`);
    const frac = m[2] || "";
    return new Dec(BigInt(m[1] + frac), frac.length);
  }
  private static align(a: Dec, b: Dec): [bigint, bigint, number] {
    const s = Math.max(a.s, b.s);
    return [a.n * 10n ** BigInt(s - a.s), b.n * 10n ** BigInt(s - b.s), s];
  }
  add(b: Dec): Dec { const [x, y, s] = Dec.align(this, b); return new Dec(x + y, s); }
  sub(b: Dec): Dec { const [x, y, s] = Dec.align(this, b); return new Dec(x - y, s); }
  mul(b: Dec): Dec { return new Dec(this.n * b.n, this.s + b.s).trim(DIV_SCALE); }
  neg(): Dec { return new Dec(-this.n, this.s); }
  div(b: Dec): Dec {
    if (b.n === 0n) throw new Error("division by zero");
    // (a.n / 10^a.s) / (b.n / 10^b.s) = a.n * 10^(b.s) / (b.n * 10^(a.s)), kept to DIV_SCALE+1 digits then rounded
    const scale = DIV_SCALE + 1;
    const num = this.n * 10n ** BigInt(b.s + scale);
    const den = b.n * 10n ** BigInt(this.s);
    return new Dec(num / den, scale).round(DIV_SCALE);
  }
  /** Round half away from zero to d decimal places. */
  round(d: number): Dec {
    if (this.s <= d) return new Dec(this.n * 10n ** BigInt(d - this.s), d);
    const f = 10n ** BigInt(this.s - d);
    const neg = this.n < 0n;
    const abs = neg ? -this.n : this.n;
    let q = abs / f;
    if ((abs % f) * 2n >= f) q += 1n;
    return new Dec(neg ? -q : q, d);
  }
  private trim(max: number): Dec { return this.s > max ? this.round(max) : this; }
  toFixed(d: number): string {
    const r = this.round(d);
    const neg = r.n < 0n;
    let digits = (neg ? -r.n : r.n).toString().padStart(d + 1, "0");
    const out = d > 0 ? digits.slice(0, -d) + "." + digits.slice(-d) : digits;
    return (neg && /[1-9]/.test(out) ? "-" : "") + out;
  }
  toPlain(maxDecimals = 10): string {
    let t = this.toFixed(maxDecimals);
    if (t.includes(".")) t = t.replace(/0+$/, "").replace(/\.$/, "");
    return t === "-0" ? "0" : t;
  }
}

type Tok = { t: "num"; v: string } | { t: "op"; v: string };

function tokenize(expr: string): Tok[] {
  // Money formatting is allowed: "$6,915.88" -> 6915.88. Unicode minus/multiply/divide are accepted.
  const s = expr.replace(/[$\s]/g, "").replace(/(\d),(?=\d{3}(\D|$))/g, "$1")
    .replace(/[−–]/g, "-").replace(/[×xX]/g, "*").replace(/÷/g, "/");
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const v = s.slice(i, j);
      if (!/^\d+(\.\d+)?$|^\.\d+$/.test(v)) throw new Error(`bad number "${v}"`);
      out.push({ t: "num", v: v.startsWith(".") ? "0" + v : v });
      i = j;
    } else if ("+-*/()".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
    } else {
      throw new Error(`unsupported character "${c}" (use numbers, + - * / and parentheses)`);
    }
  }
  if (!out.length) throw new Error("empty expression");
  return out;
}

export function evaluate(expr: string): Dec {
  if (typeof expr !== "string" || expr.length > 500) throw new Error("expression must be text under 500 characters");
  const toks = tokenize(expr);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const take = () => toks[p++];
  const parseExpr = (): Dec => {
    let v = parseTerm();
    while (peek() && peek().t === "op" && (peek().v === "+" || peek().v === "-")) {
      const op = take().v;
      const r = parseTerm();
      v = op === "+" ? v.add(r) : v.sub(r);
    }
    return v;
  };
  const parseTerm = (): Dec => {
    let v = parseFactor();
    while (peek() && peek().t === "op" && (peek().v === "*" || peek().v === "/")) {
      const op = take().v;
      const r = parseFactor();
      v = op === "*" ? v.mul(r) : v.div(r);
    }
    return v;
  };
  const parseFactor = (): Dec => {
    const tok = take();
    if (!tok) throw new Error("expression ends too early");
    if (tok.t === "num") return Dec.parse(tok.v);
    if (tok.v === "-") return parseFactor().neg();
    if (tok.v === "+") return parseFactor();
    if (tok.v === "(") {
      if (++depth > 50) throw new Error("too many parentheses");
      const v = parseExpr();
      const close = take();
      if (!close || close.v !== ")") throw new Error("missing closing parenthesis");
      depth--;
      return v;
    }
    throw new Error(`unexpected "${tok.v}"`);
  };
  const v = parseExpr();
  if (p !== toks.length) throw new Error(`unexpected "${toks[p].v}"`);
  return v;
}

export type CalcItem = { label?: string; expression: string };

export function calculateAll(items: CalcItem[], decimals = 2) {
  const d = Number.isInteger(decimals) && decimals >= 0 && decimals <= 6 ? decimals : 2;
  return items.map((it) => {
    const label = typeof it?.label === "string" ? it.label.slice(0, 200) : undefined;
    try {
      const v = evaluate(String(it?.expression ?? ""));
      return { ...(label ? { label } : {}), expression: it.expression, result: v.toFixed(d), unrounded: v.toPlain(10) };
    } catch (e: any) {
      return { ...(label ? { label } : {}), expression: it?.expression, error: String(e?.message || e) };
    }
  });
}
