import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Post, UserState } from "../types"; // Assuming types are defined

// Upload JSON object to Filebase S3 (will pin automatically)
export async function uploadJsonToFilebase(s3Client: S3Client, bucketName: string, data: Post | UserState | any, key?: string): Promise<string> {
  const jsonString = JSON.stringify(data);
  const objectKey = key || `data-${Date.now()}-${Math.random().toString(16).substring(2, 8)}.json`;

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: objectKey,
    Body: jsonString,
    ContentType: 'application/json',
  });

  try {
    await s3Client.send(command);
    const headCommand = new HeadObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
    });
    const headResult = await s3Client.send(headCommand);
    const cid = headResult.Metadata?.cid || headResult.Metadata?.CID || headResult.Metadata?.cid; // Check variations
     if (!cid) {
         console.error("HeadObject response:", headResult);
         throw new Error("CID not found in object metadata after upload.");
     }
    return cid;
  } catch (error) {
    console.error(`Error uploading JSON to Filebase S3 (${objectKey}):`, error);
    throw error;
  }
}

export async function uploadFileToFilebase(s3Client: S3Client, bucketName: string, file: File | Blob): Promise<string> {
    const fileName = (file as File).name || 'untitled';
    const objectKey = `uploads/${Date.now()}-${fileName.replace(/[^a-zA-Z0-9.]/g, '_')}`;
    // -------------------------------------------------------------------

    // CRITICAL FIX: Convert the File/Blob to a Uint8Array
    const arrayBuffer = await file.arrayBuffer();
    const bodyData = new Uint8Array(arrayBuffer);
    
    // Type checking the file's type property
    const contentType = file.type || 'application/octet-stream';

    const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
        Body: bodyData, 
        ContentType: contentType,
        ContentLength: file.size,
    });

    try {
        await s3Client.send(command);
        
        // After upload, get the CID from metadata
        const headCommand = new HeadObjectCommand({
            Bucket: bucketName,
            Key: objectKey,
        });
        const headResult = await s3Client.send(headCommand);
        const cid = headResult.Metadata?.cid || headResult.Metadata?.CID || headResult.Metadata?.Cid;
        if (!cid) {
            console.error("HeadObject response:", headResult);
            throw new Error("CID not found in object metadata after upload.");
        }
        return cid;
    } catch (error) {
        console.error(`Error uploading File to Filebase S3 (${objectKey}):`, error);
        throw error;
    }
}

// Delete object from Filebase S3
export async function deleteFromFilebase(s3Client: S3Client, bucketName: string, keyOrCid: string): Promise<void> {
    // Note: Filebase pins automatically. Deleting might unpin.
    // Assuming keyOrCid *is* the S3 Object Key for now.
    const objectKey = keyOrCid;

    const command = new DeleteObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
    });

    try {
        await s3Client.send(command);
        console.log(`Successfully deleted object from Filebase S3: ${objectKey}`);
    } catch (error) {
        console.error(`Error deleting object ${objectKey} from Filebase S3:`, error);
        // Don't throw? Or handle specific errors like NoSuchKey?
        if ((error as any).name !== 'NoSuchKey') {
             throw error; 
        } else {
             console.warn(`Attempted to delete non-existent key: ${objectKey}`);
        }
    }
}