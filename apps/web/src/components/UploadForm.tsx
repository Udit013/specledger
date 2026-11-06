import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import type { UploadRequest } from '../api/client.js';
import { useServices } from '../context.js';
import { hrefFor } from '../lib/router.js';
import { ErrorNotice } from './Status.js';

const SAMPLES = 'https://github.com/Udit013/specledger/tree/main/fixtures/corpus/pdf';

// Uploads one PDF with what the uploader knows about it. The server validates the file itself; a
// public deployment accepts only the synthetic corpus documents.
export function UploadForm() {
  const { client, announce } = useServices();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [fields, setFields] = useState<UploadRequest>({
    documentType: 'datasheet',
    revision: '',
    equipmentTag: '',
    equipmentClass: 'centrifugal_pump',
    synthetic: true,
  });
  const [problems, setProblems] = useState<string[]>([]);

  const upload = useMutation({
    mutationFn: (chosen: File) => client.uploadDocument(chosen, fields),
    onSuccess: async (result) => {
      const name = result.document.originalFilename;
      announce(
        result.duplicate
          ? `${name} was uploaded before; showing the existing document.`
          : `Uploaded ${name}. It is queued for extraction.`,
      );
      await queryClient.invalidateQueries({ queryKey: ['documents'] });
      window.location.hash = hrefFor({ name: 'documents' });
    },
  });

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const missing = [
      ...(file === null ? ['Choose a PDF file.'] : []),
      ...(fields.equipmentTag.trim() === '' ? ['Enter the equipment tag.'] : []),
    ];
    setProblems(missing);
    if (file !== null && missing.length === 0 && !upload.isPending) upload.mutate(file);
  };
  const set = <K extends keyof UploadRequest>(key: K, value: UploadRequest[K]) => {
    setFields((current) => ({ ...current, [key]: value }));
  };

  return (
    <section aria-labelledby="upload-heading" className="mx-auto max-w-2xl">
      <h2 id="upload-heading" className="page-title">
        Upload a document
      </h2>
      <p className="page-lead mb-6">
        Try one of the{' '}
        <a href={SAMPLES} className="link" rel="noreferrer" target="_blank">
          synthetic sample datasheets
        </a>
        . Extraction runs in the background; the document list shows its progress.
      </p>
      <form onSubmit={submit} noValidate className="card space-y-5 p-6 text-sm">
        <label className="field">
          PDF file
          <input
            type="file"
            accept="application/pdf,.pdf"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
            }}
            className="block w-full cursor-pointer rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 text-sm font-normal text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-brand-700 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-white hover:border-brand-500"
          />
        </label>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="field">
            Equipment tag
            <input
              value={fields.equipmentTag}
              maxLength={64}
              onChange={(e) => {
                set('equipmentTag', e.target.value);
              }}
              className="input"
            />
          </label>
          <label className="field">
            Equipment class
            <select
              value={fields.equipmentClass}
              onChange={(e) => {
                set('equipmentClass', e.target.value as UploadRequest['equipmentClass']);
              }}
              className="input"
            >
              <option value="centrifugal_pump">Centrifugal pump</option>
              <option value="electric_motor">Electric motor</option>
            </select>
          </label>
          <label className="field">
            Document type
            <select
              value={fields.documentType}
              onChange={(e) => {
                set('documentType', e.target.value as UploadRequest['documentType']);
              }}
              className="input"
            >
              <option value="datasheet">Datasheet</option>
              <option value="manual">Manual</option>
              <option value="brochure">Brochure</option>
            </select>
          </label>
          <label className="field">
            Revision (optional)
            <input
              value={fields.revision}
              maxLength={32}
              onChange={(e) => {
                set('revision', e.target.value);
              }}
              className="input"
            />
          </label>
        </div>
        <label className="flex items-start gap-3 rounded-lg bg-slate-50 p-3">
          <input
            type="checkbox"
            checked={fields.synthetic}
            onChange={(e) => {
              set('synthetic', e.target.checked);
            }}
            className="mt-0.5 h-4 w-4 accent-brand-700"
          />
          <span className="text-slate-700">
            This is a synthetic test document. Only synthetic documents are sent to the hosted
            model.
          </span>
        </label>
        {problems.length === 0 ? null : (
          <ul role="alert" className="notice notice-error list-disc pl-8">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        {upload.isError ? (
          <ErrorNotice title="The document was not uploaded." error={upload.error} />
        ) : null}
        <button type="submit" aria-disabled={upload.isPending} className="btn btn-primary">
          {upload.isPending ? 'Uploading…' : 'Upload'}
        </button>
      </form>
    </section>
  );
}
