// MinIO / S3-compatible object storage wrapper.
//
// One AWS.S3 client, path-style addressing (required for MinIO), and a
// small typed surface the rest of the server uses so we never import
// aws-sdk directly elsewhere.
//
// Env:
//   MINIO_ENDPOINT       internal URL the server uses to talk to MinIO
//                        (e.g. http://minio:9000 in compose)
//   MINIO_PUBLIC_URL     URL the browser will use to load public objects
//                        (e.g. http://localhost:9000). Defaults to
//                        MINIO_ENDPOINT when not set.
//   MINIO_BUCKET         bucket name (default "webrewind")
//   MINIO_REGION         region label (default "us-east-1" — MinIO ignores
//                        this but the SDK requires a value)
//   MINIO_ACCESS_KEY     credentials (default "minioadmin")
//   MINIO_SECRET_KEY
//
// ensureBucket() is best-effort on boot: if the bucket is missing it
// creates it, and if it fails we log and continue so the server still
// starts for /health and /metrics.

const AWS = require("aws-sdk");
const log = require("./logger");

const ENDPOINT = process.env.MINIO_ENDPOINT || "http://localhost:9000";
const PUBLIC_URL = (process.env.MINIO_PUBLIC_URL || ENDPOINT).replace(
  /\/+$/,
  ""
);
const BUCKET = process.env.MINIO_BUCKET || "webrewind";
const REGION = process.env.MINIO_REGION || "us-east-1";
const ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "minioadmin";
const SECRET_KEY = process.env.MINIO_SECRET_KEY || "minioadmin";

const s3 = new AWS.S3({
  endpoint: ENDPOINT,
  accessKeyId: ACCESS_KEY,
  secretAccessKey: SECRET_KEY,
  region: REGION,
  // MinIO requires path-style (host/bucket/key). Virtual-hosted style would
  // try to hit bucket.host which doesn't resolve in the compose network.
  s3ForcePathStyle: true,
  signatureVersion: "v4",
});

async function putObject(key, body, contentType, extra = {}) {
  await s3
    .putObject({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      // Captures + GIFs are immutable per (outputFileName, index); the only
      // way they change is a full rebuild that overwrites them.
      CacheControl:
        extra.cacheControl || "public, max-age=31536000, immutable",
    })
    .promise();
}

async function getObjectJSON(key) {
  try {
    const data = await s3.getObject({ Bucket: BUCKET, Key: key }).promise();
    return JSON.parse(data.Body.toString("utf8"));
  } catch (err) {
    if (
      err.code === "NoSuchKey" ||
      err.code === "NotFound" ||
      err.statusCode === 404
    ) {
      return null;
    }
    throw err;
  }
}

async function deleteObject(key) {
  try {
    await s3.deleteObject({ Bucket: BUCKET, Key: key }).promise();
  } catch (err) {
    if (err.code !== "NoSuchKey") throw err;
  }
}

async function deletePrefix(prefix) {
  let ContinuationToken;
  do {
    const list = await s3
      .listObjectsV2({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken,
      })
      .promise();
    const objs = (list.Contents || []).map((o) => ({ Key: o.Key }));
    if (objs.length > 0) {
      await s3
        .deleteObjects({
          Bucket: BUCKET,
          Delete: { Objects: objs, Quiet: true },
        })
        .promise();
    }
    ContinuationToken = list.IsTruncated ? list.NextContinuationToken : null;
  } while (ContinuationToken);
}

function buildPublicUrl(key) {
  // MinIO with path-style: <host>/<bucket>/<key>. encodeURI keeps slashes
  // so nested keys still address correctly.
  return `${PUBLIC_URL}/${BUCKET}/${encodeURI(key)}`;
}

async function ensureBucket() {
  try {
    await s3.headBucket({ Bucket: BUCKET }).promise();
  } catch (err) {
    if (err.statusCode === 404 || err.code === "NoSuchBucket") {
      try {
        await s3.createBucket({ Bucket: BUCKET }).promise();
        log.info("storage: bucket created", { bucket: BUCKET });
      } catch (cerr) {
        // Another process (e.g. the minio-init sidecar in compose) likely
        // beat us to it — that's fine.
        if (
          cerr.code !== "BucketAlreadyOwnedByYou" &&
          cerr.code !== "BucketAlreadyExists"
        ) {
          throw cerr;
        }
      }
    } else {
      throw err;
    }
  }
}

module.exports = {
  BUCKET,
  putObject,
  getObjectJSON,
  deleteObject,
  deletePrefix,
  buildPublicUrl,
  ensureBucket,
};
