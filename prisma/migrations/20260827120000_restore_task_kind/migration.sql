-- Take the card back off a chapter.
--
-- Carding was one-way: findExtraChapters skips anything already carded, so
-- nothing revisited one and a chapter carded by mistake stayed carded. Adding
-- the kind is additive; no existing row changes.
ALTER TYPE "UploadTaskKind" ADD VALUE 'RESTORE';
