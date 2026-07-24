import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const getEndpoint = () => process.env.S3_ENDPOINT || 'https://s3-bucket-v3c.sidattech.com';
const getAccessKeyId = () => process.env.S3_ACCESS_KEY || 'Vv9dcue5SxXhs2tJ';
const getSecretAccessKey = () => process.env.S3_SECRET_KEY || '0lCZz4z9dpLI05yIP2q9S2HvhBP9zO4a';
const getBucketName = () => process.env.S3_BUCKET || 'v3c-uploads';
const getRegion = () => process.env.S3_REGION || 'us-east-1';

export const getS3Client = () => new S3Client({
  endpoint: getEndpoint(),
  region: getRegion(),
  credentials: {
    accessKeyId: getAccessKeyId(),
    secretAccessKey: getSecretAccessKey(),
  },
  forcePathStyle: true,
});

export const s3Client = getS3Client();

export const uploadFileToS3 = async (
  fileBuffer: Buffer,
  fileKey: string,
  contentType: string
): Promise<string> => {
  const currentEndpoint = getEndpoint();
  const currentBucket = getBucketName();
  const client = getS3Client();

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: currentBucket,
        Key: fileKey,
        Body: fileBuffer,
        ContentType: contentType,
      })
    );
    return `${currentEndpoint}/${currentBucket}/${fileKey}`;
  } catch (err: any) {
    console.warn(`[S3 Upload Warning] S3 upload failed for ${fileKey}. Using resilient Data URL fallback:`, err?.message || err);
    const mime = contentType || 'image/png';
    return `data:${mime};base64,${fileBuffer.toString('base64')}`;
  }
};

export const deleteFileFromS3 = async (fileKey: string): Promise<void> => {
  const client = getS3Client();
  await client.send(
    new DeleteObjectCommand({
      Bucket: getBucketName(),
      Key: fileKey,
    })
  );
};

export const getSignedDownloadUrl = async (fileKey: string, expiresInSeconds = 3600): Promise<string> => {
  const client = getS3Client();
  const command = new GetObjectCommand({
    Bucket: getBucketName(),
    Key: fileKey,
  });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
};
