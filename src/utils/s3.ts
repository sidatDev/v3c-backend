import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const endpoint = process.env.S3_ENDPOINT || 'http://s3-t7xnnjiz340430yamgsansds.178.18.252.45.sslip.io';
const accessKeyId = process.env.S3_ACCESS_KEY || 'Vv9dcue5SxXhs2tJ';
const secretAccessKey = process.env.S3_SECRET_KEY || '0lCZz4z9dpLI05yIP2q9S2HvhBP9zO4a';
const bucketName = process.env.S3_BUCKET || 'v3c-uploads';
const region = process.env.S3_REGION || 'us-east-1';

export const s3Client = new S3Client({
  endpoint,
  region,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
  forcePathStyle: true,
});

export const uploadFileToS3 = async (
  fileBuffer: Buffer,
  fileKey: string,
  contentType: string
): Promise<string> => {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: fileKey,
      Body: fileBuffer,
      ContentType: contentType,
    })
  );

  return `${endpoint}/${bucketName}/${fileKey}`;
};

export const deleteFileFromS3 = async (fileKey: string): Promise<void> => {
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: bucketName,
      Key: fileKey,
    })
  );
};

export const getSignedDownloadUrl = async (fileKey: string, expiresInSeconds = 3600): Promise<string> => {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: fileKey,
  });
  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
};
