export type TranslationUnitKind =
  | "paragraph"
  | "heading"
  | "list_item"
  | "blockquote"
  | "table_cell"
  | "plain_text"
  | "protected";

export interface TranslationUnit {
  unitId: string;
  fileId: string;
  order: number;
  kind: TranslationUnitKind;
  sourceStart: number;
  sourceEnd: number;
  sourceText: string;
  prefix?: string;
  suffix?: string;
  translatable: boolean;
  tokenCount: number;
  structuralContext?: {
    headingPath?: string[];
    listDepth?: number;
    quoteDepth?: number;
    tableId?: string;
    splitFromUnitId?: string;
    splitPartIndex?: number;
    splitPartCount?: number;
    hardCut?: boolean;
  };
}

export interface TranslationSegment {
  segmentId: string;
  fileId: string;
  indexInFile: number;
  globalIndex: number;
  unitIds: string[];
  sourceTokenCount: number;
  sourceTextSnapshotPath: string;
  sourceText: string;
  startsMidUnit: boolean;
  endsMidUnit: boolean;
}

export type CountTextTokens = (text: string) => number;
