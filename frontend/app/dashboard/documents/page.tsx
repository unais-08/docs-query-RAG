"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  Check,
  ExternalLink,
  FileText,
  FileType2,
  Inbox,
  Loader2,
  Pencil,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/context/auth-context";
import {
  deleteDocument,
  getDocument,
  getDocuments,
  renameDocument,
  uploadDocument,
  validateDocumentFile,
  type Document,
} from "@/lib/api/documents";

type DocumentStatus = "Ready" | "Processing" | "Failed";
type DocumentItem = Omit<Document, "status"> & { sizeLabel: string; status: DocumentStatus };

function toDocumentItem(document: Document): DocumentItem {
  const status: DocumentStatus = document.status === "ready"
    ? "Ready"
    : document.status === "failed"
      ? "Failed"
      : "Processing";
  return {
    ...document,
    sizeLabel: `${(document.size / (1024 * 1024)).toFixed(1)} MB`,
    status,
  };
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function documentType(type: string) {
  return type.includes("pdf") ? "PDF" : "DOCX";
}

// Extension-based styling so the file icon/badge reflects the actual type
// (PDF vs DOCX) instead of one generic look for every document.
function fileTypeStyle(type: string) {
  return documentType(type) === "PDF"
    ? {
      Icon: FileText,
      iconBg: "bg-red-50",
      iconText: "text-red-600",
      badge: "bg-red-50 text-red-600",
    }
    : {
      Icon: FileType2,
      iconBg: "bg-docs-blue-50",
      iconText: "text-docs-blue-600",
      badge: "bg-docs-blue-50 text-docs-blue-700",
    };
}

export default function DocumentsPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { token, loading: authLoading } = useAuth();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [savingRename, setSavingRename] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    const refreshDocuments = () => void getDocuments(token)
      .then((response) => {
        if (!cancelled) setDocuments(response.documents.map(toDocumentItem));
      })
      .catch((requestError: unknown) => {
        if (!cancelled) toast.error(getErrorMessage(requestError, "Failed to load documents."));
      })
      .finally(() => {
        if (!cancelled) setDocumentsLoading(false);
      });
    refreshDocuments();
    const poll = window.setInterval(refreshDocuments, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(poll);
    };
  }, [token]);

  const filteredDocuments = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return documents;
    return documents.filter((document) =>
      document.name.toLowerCase().includes(normalizedQuery),
    );
  }, [documents, query]);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];

    const validationError = validateDocumentFile(file);
    if (validationError) {
      toast.error(validationError);
      return;
    }
    if (!token) {
      toast.error("Your session has expired. Please sign in again.");
      return;
    }

    setUploading(true);
    const uploadToast = toast.loading("Uploading document...");
    try {
      const response = await uploadDocument(file, token);
      setDocuments((previous) => [toDocumentItem(response.document), ...previous]);
      toast.success("Document queued for processing", { id: uploadToast });
    } catch {
      toast.error("Failed to upload document", { id: uploadToast });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (uploading) return;
    setIsDragging(false);
    void handleFiles(event.dataTransfer.files);
  };

  const handleDelete = async (id: string) => {
    const document = documents.find((item) => item.id === id);
    if (!document || !window.confirm(`Delete "${document.name}"? This can't be undone.`)) return;
    if (!token) {
      toast.error("Your session has expired. Please sign in again.");
      return;
    }

    setDeletingId(id);
    const deleteToast = toast.loading("Deleting document...");
    try {
      await deleteDocument(id, token);
      setDocuments((previous) => previous.filter((item) => item.id !== id));
      toast.success("Document deleted successfully", { id: deleteToast });
    } catch {
      toast.error("Failed to delete document", { id: deleteToast });
    } finally {
      setDeletingId(null);
    }
  };

  const startRename = (document: DocumentItem) => {
    setRenamingId(document.id);
    setDraftName(document.name);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setDraftName("");
  };

  const confirmRename = async (id: string) => {
    const name = draftName.trim();
    if (!name) {
      toast.error("Document name cannot be empty.");
      return;
    }
    if (!token) {
      toast.error("Your session has expired. Please sign in again.");
      return;
    }

    setSavingRename(true);
    const renameToast = toast.loading("Renaming document...");
    try {
      const response = await renameDocument(id, name, token);
      setDocuments((previous) =>
        previous.map((item) =>
          item.id === id ? toDocumentItem(response.document) : item,
        ),
      );
      cancelRename();
      toast.success("Document renamed successfully", { id: renameToast });
    } catch {
      toast.error("Failed to rename document", { id: renameToast });
    } finally {
      setSavingRename(false);
    }
  };

  const handleOpen = async (id: string) => {
    if (!token) {
      toast.error("Your session has expired. Please sign in again.");
      return;
    }
    try {
      await getDocument(id, token);
      toast.info("This document is stored securely, but preview is not available yet.");
    } catch (requestError) {
      toast.error(getErrorMessage(requestError, "Unable to open this document."));
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Documents</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Upload the files you want to ask questions about.
          </p>
        </div>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-docs-md bg-brand-600 px-4 text-sm font-semibold text-white shadow-lg shadow-brand-600/20 transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Upload size={16} />
          {uploading ? "Uploading..." : "Upload document"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx"
          className="hidden"
          onChange={(event) => void handleFiles(event.target.files)}
        />
      </div>

      <div
        onClick={() => {
          if (!uploading) fileInputRef.current?.click();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (uploading) return;
          setIsDragging(true);
        }}
        onDragLeave={() => {
          if (!uploading) setIsDragging(false);
        }}
        onDrop={handleDrop}
        aria-disabled={uploading}
        className={`flex flex-col items-center gap-3 rounded-docs-lg border-2 border-dashed px-6 py-8 text-center transition ${uploading
          ? "cursor-not-allowed border-border bg-background opacity-60"
          : `cursor-pointer ${isDragging
          ? "border-brand-500 bg-brand-50"
          : "border-border bg-surface hover:border-brand-300 hover:bg-brand-50/40"
          }`}`}
      >
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-100 text-brand-600">
          {uploading ? <Loader2 size={20} className="animate-spin" /> : <Upload size={20} />}
        </div>
        <div>
          <p className="text-sm font-medium text-text-primary">
            {uploading ? "Uploading document..." : "Drag and drop a file, or click to browse"}
          </p>
          <p className="mt-1 text-xs text-text-muted">PDF or DOCX · Up to 10MB</p>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-sm font-semibold text-text-primary">
          {documents.length} {documents.length === 1 ? "document" : "documents"}
        </h2>
        {documents.length > 0 && (
          <div className="relative w-full sm:w-64">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search documents"
              className="h-9 w-full rounded-docs-md border border-border bg-surface pl-9 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100"
            />
          </div>
        )}
      </div>

      {authLoading || (token ? documentsLoading : false) ? (
        <div className="rounded-docs-lg border border-border bg-surface px-6 py-10 text-center text-sm text-text-secondary shadow-docs-card">
          Loading documents...
        </div>
      ) : documents.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-docs-lg border border-border bg-surface px-6 py-14 text-center shadow-docs-card">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-600">
            <Inbox size={22} />
          </div>
          <div>
            <h3 className="font-medium text-text-primary">No documents yet</h3>
          </div>
        
        </div>
      ) : filteredDocuments.length === 0 ? (
        <div className="rounded-docs-lg border border-border bg-surface px-6 py-10 text-center text-sm text-text-secondary shadow-docs-card">
          No documents match &ldquo;{query}&rdquo;.
        </div>
      ) : (
        <div className="overflow-hidden rounded-docs-lg border border-border bg-surface shadow-docs-card">
          {/* Table view — sm and up */}
          <table className="hidden w-full text-left sm:table">
            <thead>
              <tr className="border-b border-border text-xs font-medium text-text-muted">
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Type</th>
                <th className="px-5 py-3 font-medium">Size</th>
                <th className="px-5 py-3 font-medium">Uploaded</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-border">
              {filteredDocuments.map((document) => {
                const style = fileTypeStyle(document.type);
                const FileIcon = style.Icon;

                return (
                  <tr key={document.id} className="transition hover:bg-background">
                    <td className="px-5 py-4">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-docs-md ${style.iconBg} ${style.iconText}`}>
                          <FileIcon size={17} />
                        </div>

                        {renamingId === document.id ? (
                          <div className="flex min-w-0 items-center gap-2">
                            <input
                              autoFocus
                              value={draftName}
                              onChange={(event) => setDraftName(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") void confirmRename(document.id);
                                if (event.key === "Escape") cancelRename();
                              }}
                              className="h-8 w-full max-w-xs rounded-md border border-brand-300 bg-surface px-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand-100"
                            />
                            <button type="button" onClick={() => void confirmRename(document.id)} disabled={savingRename} className="rounded p-1.5 text-brand-600 hover:bg-brand-50 disabled:opacity-50" title="Save">
                              <Check size={15} />
                            </button>
                            <button type="button" onClick={cancelRename} disabled={savingRename} className="rounded p-1.5 text-text-muted hover:bg-background" title="Cancel">
                              <X size={15} />
                            </button>
                          </div>
                        ) : (
                          <p className="truncate text-sm font-medium text-text-primary">{document.name}</p>
                        )}
                      </div>
                    </td>

                    <td className="px-5 py-4">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${style.badge}`}>
                        {documentType(document.type)}
                      </span>
                    </td>

                    <td className="px-5 py-4 text-sm text-text-secondary">{document.sizeLabel}</td>

                    <td className="px-5 py-4 text-sm text-text-secondary">{formatDate(document.createdAt)}</td>

                    <td className="px-5 py-4">
                      <StatusBadge status={document.status} />
                    </td>

                    <td className="px-5 py-4">
                      {renamingId !== document.id && (
                        <div className="flex items-center justify-end gap-1">
                          <button type="button" title="Open" onClick={() => void handleOpen(document.id)} className="hidden rounded-md p-2 text-text-secondary hover:bg-background hover:text-text-primary sm:inline-flex">
                            <ExternalLink size={16} />
                          </button>
                          <button type="button" title="Rename" onClick={() => startRename(document)} disabled={deletingId !== null} className="rounded-md p-2 text-text-secondary hover:bg-background hover:text-text-primary disabled:opacity-50">
                            <Pencil size={16} />
                          </button>
                          <button type="button" title="Delete" onClick={() => void handleDelete(document.id)} disabled={deletingId === document.id} className="rounded-md p-2 text-text-secondary hover:bg-red-50 hover:text-danger disabled:opacity-50">
                            {deletingId === document.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Stacked card view — below sm, where a table can't fit */}
          <div className="divide-y divide-border sm:hidden">
            {filteredDocuments.map((document) => {
              const style = fileTypeStyle(document.type);
              const FileIcon = style.Icon;

              return (
                <div key={document.id} className="flex items-center gap-3 px-5 py-4 transition hover:bg-background">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-docs-md ${style.iconBg} ${style.iconText}`}>
                    <FileIcon size={18} />
                  </div>

                  <div className="min-w-0 flex-1">
                    {renamingId === document.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          autoFocus
                          value={draftName}
                          onChange={(event) => setDraftName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void confirmRename(document.id);
                            if (event.key === "Escape") cancelRename();
                          }}
                          className="h-8 w-full rounded-md border border-brand-300 bg-surface px-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand-100"
                        />
                        <button type="button" onClick={() => void confirmRename(document.id)} disabled={savingRename} className="rounded p-1.5 text-brand-600 hover:bg-brand-50 disabled:opacity-50" title="Save">
                          <Check size={15} />
                        </button>
                        <button type="button" onClick={cancelRename} disabled={savingRename} className="rounded p-1.5 text-text-muted hover:bg-background" title="Cancel">
                          <X size={15} />
                        </button>
                      </div>
                    ) : (
                      <>
                        <p className="truncate text-sm font-medium text-text-primary">{document.name}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                          <span className={`inline-flex rounded-full px-2 py-0.5 font-medium ${style.badge}`}>
                            {documentType(document.type)}
                          </span>
                          <span>{document.sizeLabel}</span>
                          <span>·</span>
                          <span>{formatDate(document.createdAt)}</span>
                        </div>
                      </>
                    )}
                  </div>

                  {renamingId !== document.id && (
                    <div className="flex shrink-0 items-center gap-1">
                      <StatusBadge status={document.status} />
                      <button type="button" title="Rename" onClick={() => startRename(document)} disabled={deletingId !== null} className="rounded-md p-2 text-text-secondary hover:bg-background hover:text-text-primary disabled:opacity-50">
                        <Pencil size={16} />
                      </button>
                      <button type="button" title="Delete" onClick={() => void handleDelete(document.id)} disabled={deletingId === document.id} className="rounded-md p-2 text-text-secondary hover:bg-red-50 hover:text-danger disabled:opacity-50">
                        {deletingId === document.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: DocumentStatus }) {
  const styles: Record<DocumentStatus, string> = {
    Ready: "bg-green-50 text-green-700",
    Processing: "bg-docs-blue-50 text-docs-blue-700",
    Failed: "bg-red-50 text-danger",
  };

  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${styles[status]}`}>{status}</span>;
}
