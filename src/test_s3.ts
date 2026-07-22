import dotenv from 'dotenv';
import { 
  S3Client, 
  ListBucketsCommand, 
  CreateBucketCommand, 
  PutObjectCommand, 
  GetObjectCommand 
} from '@aws-sdk/client-s3';

dotenv.config();

const endpoint = process.env.S3_ENDPOINT || 'http://s3-t7xnnjiz340430yamgsansds.178.18.252.45.sslip.io';
const accessKeyId = process.env.S3_ACCESS_KEY || 'Vv9dcue5SxXhs2tJ';
const secretAccessKey = process.env.S3_SECRET_KEY || '0lCZz4z9dpLI05yIP2q9S2HvhBP9zO4a';
const bucketName = process.env.S3_BUCKET || 'v3c-uploads';
const region = process.env.S3_REGION || 'us-east-1';

console.log('--- Testing SeaweedFS S3 Connection ---');
console.log(`Endpoint: ${endpoint}`);
console.log(`Access Key: ${accessKeyId}`);
console.log(`Bucket Target: ${bucketName}`);

const s3Client = new S3Client({
  endpoint,
  region,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
  forcePathStyle: true, // Required for self-hosted S3/SeaweedFS/MinIO
});

async function testConnection() {
  try {
    // 1. List Buckets
    console.log('\n[1/3] Fetching existing buckets...');
    const listRes = await s3Client.send(new ListBucketsCommand({}));
    const buckets = listRes.Buckets?.map(b => b.Name) || [];
    console.log('✓ Connected successfully!');
    console.log(`Available Buckets (${buckets.length}):`, buckets);

    // 2. Ensure target bucket exists
    if (!buckets.includes(bucketName)) {
      console.log(`\n[2/3] Bucket '${bucketName}' not found. Creating bucket...`);
      await s3Client.send(new CreateBucketCommand({ Bucket: bucketName }));
      console.log(`✓ Bucket '${bucketName}' created successfully.`);
    } else {
      console.log(`\n[2/3] Bucket '${bucketName}' exists.`);
    }

    // 3. Upload test object
    console.log('\n[3/3] Uploading test object to SeaweedFS S3...');
    const testKey = `test-connection-${Date.now()}.txt`;
    await s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: testKey,
      Body: 'V3C Platform - SeaweedFS Connection Verified!',
      ContentType: 'text/plain'
    }));
    console.log(`✓ PutObject succeeded! Test object key: ${testKey}`);

    console.log('\n=============================================');
    console.log('🎉 SUCCESS: SeaweedFS S3 Connection is VERIFIED!');
    console.log('=============================================');
  } catch (err: any) {
    console.error('\n❌ SeaweedFS Connection Failed:', err.message || err);
    if (err.stack) {
      console.error(err.stack);
    }
  }
}

testConnection();
