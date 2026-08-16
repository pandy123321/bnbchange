// 自实现轻量 Blockies：基于地址哈希生成稳定的 5x5 镜像色块头像，无外部依赖。
// 同一地址始终得到相同颜色与图案。

function hashBytes(address: string): number[] {
  const s = address.toLowerCase().replace(/^0x/, "");
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i += 2) {
    const byte = parseInt(s.slice(i, i + 2), 16);
    if (!Number.isNaN(byte)) bytes.push(byte);
  }
  return bytes;
}

interface Cell {
  x: number;
  y: number;
  color: string;
}

export function Blockies({
  address,
  size = 24,
}: {
  address: string;
  size?: number;
}) {
  const bytes = hashBytes(address);
  const bg = `hsl(${bytes[0] ?? 0} 55% 22%)`;
  const fg = `hsl(${bytes[1] ?? 130} 65% 55%)`;
  const spot = `hsl(${bytes[2] ?? 250} 75% 62%)`;

  const cells: Cell[] = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const idx = y * 3 + x;
      const b = bytes[idx % Math.max(bytes.length, 1)] ?? 0;
      if (b % 2 !== 0) continue; // 确定性开/关
      const color = b % 3 === 0 ? spot : fg;
      cells.push({ x, y, color });
      if (x !== 2) cells.push({ x: 4 - x, y, color }); // 水平镜像
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 5 5"
      className="rounded shrink-0"
      aria-hidden="true"
    >
      <rect width="5" height="5" fill={bg} />
      {cells.map((c, i) => (
        <rect key={i} x={c.x} y={c.y} width="1" height="1" fill={c.color} />
      ))}
    </svg>
  );
}

export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
