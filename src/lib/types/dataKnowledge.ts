/**
 * Domain-level kinds for notes stored in the Data knowledge layer.
 */
export type DataDocumentKind = "chat_archive" | "concept" | "case" | "index";

/**
 * Upsert behavior for Data knowledge documents.
 */
export type DataUpsertPolicy = "create_or_merge";

/**
 * A lightweight semantic/data link to another entity or document.
 */
export interface DataLink {
  /**
   * Target identifier (for example, a vault-relative path, slug, or stable id).
   */
  target: string;
  /**
   * Optional relation label (for example, "supports", "depends_on", "example_of").
   */
  relation?: string;
  /**
   * Optional confidence score in range [0..1] when produced by extraction.
   */
  confidence?: number;
  /**
   * Optional extra structured payload kept open for future schema evolution.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Normalized extraction payload produced by the Data knowledge layer.
 */
export interface DataExtractionResult {
  kind: DataDocumentKind;
  /**
   * Optional extracted title/canonical name for the target artifact.
   */
  title?: string;
  /**
   * Optional extracted abstract/body in markdown or plain text.
   */
  content?: string;
  /**
   * Outgoing semantic links discovered during extraction.
   */
  links?: DataLink[];
  /**
   * Upsert policy chosen for persistence.
   */
  upsertPolicy?: DataUpsertPolicy;
  /**
   * Additional extraction attributes (entities, tags, facets, etc.).
   */
  metadata?: Record<string, unknown>;
}
