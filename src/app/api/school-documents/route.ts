import { randomUUID } from "node:crypto";
import { del, put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { rejectCrossOriginWrite, requireSchoolSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES_PER_UPLOAD = 1;
const MAX_REQUEST_SIZE = 11 * 1024 * 1024;

function documentType(bytes: Buffer) {
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return { mimeType: "application/pdf", extension: "pdf" };
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  return null;
}

function safeFilename(filename: string) {
  return filename.replace(/^.*[\\/]/, "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160) || "justificatif";
}

export async function GET() {
  const access = await requireSchoolSession({ allowPending: true });
  if (access.response) return access.response;
  const schoolId = access.session.user.schoolId;
  if (!schoolId) return NextResponse.json({ error: "Établissement introuvable." }, { status: 404 });

  try {
    const [school, documents] = await Promise.all([
      prisma.school.findUnique({
        where: { id: schoolId },
        select: { name: true, verificationStatus: true, verificationNote: true },
      }),
      prisma.schoolDocument.findMany({
        where: { schoolId },
        orderBy: { createdAt: "desc" },
        select: { id: true, originalName: true, mimeType: true, size: true, createdAt: true },
      }),
    ]);
    return NextResponse.json({ school, documents });
  } catch (error) {
    console.error("School verification status read failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Impossible de charger le dossier de vérification." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const originError = rejectCrossOriginWrite(request);
  if (originError) return originError;
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_SIZE) {
    return NextResponse.json({ error: "Le dépôt dépasse la taille maximale autorisée." }, { status: 413 });
  }

  const access = await requireSchoolSession({ allowPending: true });
  if (access.response) return access.response;
  const school = access.session.user.school;
  if (!school) return NextResponse.json({ error: "Établissement introuvable." }, { status: 404 });
  if (school.verificationStatus === "APPROVED") {
    return NextResponse.json({ error: "Le compte est déjà validé. Contactez l’assistance en cas de problème." }, { status: 409 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Formulaire de dépôt invalide." }, { status: 400 });
  }

  const submitted = form.getAll("files");
  if (submitted.length !== MAX_FILES_PER_UPLOAD || submitted.some((item) => typeof item === "string")) {
    return NextResponse.json({ error: "Sélectionnez un seul justificatif officiel." }, { status: 400 });
  }

  const files: { originalName: string; mimeType: string; extension: string; bytes: Buffer; storageKey: string }[] = [];
  for (const item of submitted) {
    if (typeof item === "string" || item.size === 0 || item.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "Le justificatif doit peser au maximum 10 Mo." }, { status: 400 });
    }
    const bytes = Buffer.from(await item.arrayBuffer());
    const type = documentType(bytes);
    if (!type) {
      return NextResponse.json({ error: "Formats acceptés : PDF, JPG et PNG uniquement." }, { status: 400 });
    }
    files.push({
      originalName: safeFilename(item.name),
      mimeType: type.mimeType,
      extension: type.extension,
      bytes,
      storageKey: `school-documents/${school.id}/${randomUUID()}.${type.extension}`,
    });
  }

  const uploadedBlobs: string[] = [];
  try {
    for (const file of files) {
      await put(file.storageKey, file.bytes, {
        access: "private",
        contentType: file.mimeType,
        addRandomSuffix: false,
      });
      uploadedBlobs.push(file.storageKey);
    }

    await prisma.$transaction(async (transaction) => {
      await transaction.schoolDocument.createMany({
        data: files.map(({ originalName, mimeType, bytes, storageKey }) => ({
          schoolId: school.id,
          originalName,
          mimeType,
          storageKey,
          size: bytes.length,
        })),
      });
      await transaction.school.update({
        where: { id: school.id },
        data: { verificationStatus: "PENDING_REVIEW", verificationNote: null },
      });
    });

    return NextResponse.json({ uploaded: files.length }, { status: 201 });
  } catch (error) {
    await Promise.all(uploadedBlobs.map((key) => del(key).catch(() => undefined)));
    console.error("School verification upload failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Le dépôt a échoué. Vérifiez le stockage et réessayez." }, { status: 503 });
  }
}
