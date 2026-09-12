export interface LocalSubtitleNativeBinaryIdentity {
  readonly format:
    | "mach-o"
    | "mach-o-fat"
    | "mach-o-fat-invalid"
    | "pe"
    | "unknown";
  readonly architectures: readonly string[];
  readonly minimumOsVersion: string | null;
}

export function inspectLocalSubtitleNativeBinary(
  buffer: Buffer,
): LocalSubtitleNativeBinaryIdentity {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    return { format: "unknown", architectures: [], minimumOsVersion: null };
  }

  const magicBe = buffer.readUInt32BE(0);
  if (magicBe === 0xcafebabe || magicBe === 0xcafebabf) {
    const is64 = magicBe === 0xcafebabf;
    const entrySize = is64 ? 32 : 20;
    const count = buffer.readUInt32BE(4);
    if (count < 1 || count > 16 || buffer.length < 8 + count * entrySize) {
      return {
        format: "mach-o-fat-invalid",
        architectures: [],
        minimumOsVersion: null,
      };
    }
    const architectures: string[] = [];
    for (let index = 0; index < count; index += 1) {
      architectures.push(
        mapMachCpuType(buffer.readUInt32BE(8 + index * entrySize)),
      );
    }
    return {
      format: "mach-o-fat",
      architectures: [...new Set(architectures)],
      minimumOsVersion: null,
    };
  }

  const magicLe = buffer.readUInt32LE(0);
  if (magicLe === 0xfeedfacf || magicBe === 0xfeedfacf) {
    const littleEndian = magicLe === 0xfeedfacf;
    const read32 = littleEndian
      ? (offset: number) => buffer.readUInt32LE(offset)
      : (offset: number) => buffer.readUInt32BE(offset);
    const architecture = mapMachCpuType(read32(4));
    const commandCount = read32(16);
    let offset = 32;
    let minimumOsVersion: string | null = null;
    for (let index = 0; index < commandCount; index += 1) {
      if (offset + 8 > buffer.length) break;
      const command = read32(offset);
      const commandSize = read32(offset + 4);
      if (commandSize < 8 || offset + commandSize > buffer.length) break;
      if (command === 0x32 && commandSize >= 24) {
        minimumOsVersion = decodePackedVersion(read32(offset + 12));
      } else if (command === 0x24 && commandSize >= 16) {
        minimumOsVersion = decodePackedVersion(read32(offset + 8));
      }
      offset += commandSize;
    }
    return {
      format: "mach-o",
      architectures: [architecture],
      minimumOsVersion,
    };
  }

  if (buffer[0] === 0x4d && buffer[1] === 0x5a && buffer.length >= 64) {
    const peOffset = buffer.readUInt32LE(0x3c);
    if (
      peOffset + 6 <= buffer.length &&
      buffer.toString("binary", peOffset, peOffset + 4) === "PE\0\0"
    ) {
      return {
        format: "pe",
        architectures: [mapPeMachine(buffer.readUInt16LE(peOffset + 4))],
        minimumOsVersion: null,
      };
    }
  }

  return { format: "unknown", architectures: [], minimumOsVersion: null };
}

function mapMachCpuType(value: number): string {
  if (value === 0x0100000c) return "arm64";
  if (value === 0x01000007) return "x64";
  return `mach-${value.toString(16)}`;
}

function mapPeMachine(value: number): string {
  if (value === 0x8664) return "x64";
  if (value === 0xaa64) return "arm64";
  return `pe-${value.toString(16)}`;
}

function decodePackedVersion(value: number): string {
  return `${(value >>> 16) & 0xffff}.${(value >>> 8) & 0xff}.${value & 0xff}`;
}
