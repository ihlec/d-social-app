// src/features/feed/NewPostForm.tsx
import React, { useState, useRef } from 'react';
import { Post } from '../../types';
import { AddMediaIcon } from '../../components/Icons';

interface NewPostFormProps {
  onAddPost: (postData: { content: string; referenceCID?: string; file?: File }) => void;
  isProcessing: boolean;
  isCoolingDown: boolean;
  countdown: number;
  replyingToPost: Post | null;
  // --- FIX: Add prop for author name ---
  replyingToAuthorName?: string | null;
  // --- End Fix ---
}

const NewPostForm: React.FC<NewPostFormProps> = ({
  onAddPost,
  isProcessing,
  isCoolingDown, // Still needed for display text
  countdown, // Still needed for display text
  replyingToPost,
  // --- FIX: Destructure author name ---
  replyingToAuthorName,
  // --- End Fix ---
}) => {
  const [content, setContent] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const isMedia = file.type.startsWith('image/') || file.type.startsWith('video/');
      const isPdf = file.type === 'application/pdf';
      if (!isMedia && !isPdf) {
        alert('Only image, video, and PDF files are supported.');
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }
      setSelectedFile(file);
      if (isMedia && previewUrl) {
          URL.revokeObjectURL(previewUrl); // Clean up previous preview
      }
      setPreviewUrl(isMedia ? URL.createObjectURL(file) : null);
    } else {
        resetFile();
    }
  };

  const resetFile = () => {
    setSelectedFile(null);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setPreviewUrl(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = ''; // Reset file input
    }
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Keep the isProcessing check, and the check for empty content/no file
    if (isProcessing || (!content.trim() && !selectedFile)) return;

    onAddPost({
      content: content,
      referenceCID: replyingToPost ? replyingToPost.id : undefined,
      file: selectedFile || undefined,
    });
    setContent('');
    resetFile();
  };

  // --- FIX: Modify isDisabled logic ---
  // The button is disabled if processing OR if there's no content AND no file.
  // The cooldown state no longer affects whether the button is *disabled*, only its text.
  const isDisabled = isProcessing || (!content.trim() && !selectedFile);
  // --- End Fix ---

  // Button text *still* shows cooldown when relevant
  const buttonText = replyingToPost
    ? (isProcessing ? "Replying..." : "Reply")
    : (isProcessing ? "Publishing..." : (isCoolingDown ? `Wait ${countdown}s` : "Create Post"));

  // --- FIX: Use author name if available, fallback to key ---
  const replyTargetDisplay = replyingToAuthorName || replyingToPost?.authorKey.substring(0, 8) || 'user';
  // --- End Fix ---

  return (
    <form onSubmit={handleSubmit} className="new-post-form">
      {/* --- FIX: Use replyTargetDisplay --- */}
      {replyingToPost && <p style={{ fontSize: '0.9em', color: 'var(--text-secondary-color)' }}>Replying to {replyTargetDisplay}...</p>}
      {/* --- End Fix --- */}
      <textarea
        className="new-post-textarea"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={replyingToPost ? 'Write your reply...' : "What's on your mind?"}
        rows={replyingToPost ? 3 : 5}
        maxLength={500} // Example max length
      />

       <input
        type="file"
        id="file-upload"
        ref={fileInputRef}
        className="file-input" // Hidden via CSS
        accept="image/*,video/*,.pdf"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />
       <label htmlFor="file-upload" className="file-input-label" title="Add Image/Video/PDF">
           <AddMediaIcon />
       </label>

      {/* Media Preview */}
      {(previewUrl || selectedFile) && (
        <div className="media-preview">
          {previewUrl && selectedFile?.type.startsWith('image/') && <img src={previewUrl} alt="Preview" />}
          {previewUrl && selectedFile?.type.startsWith('video/') && <video src={previewUrl} controls />}
          {selectedFile?.type === 'application/pdf' && <span className="file-name-preview">{selectedFile.name}</span>}
          <button type="button" onClick={resetFile} className="remove-file-button" title="Remove file">×</button>
        </div>
      )}


      <button type="submit" className="new-post-button" disabled={isDisabled}>
        {buttonText}
      </button>
    </form>
  );
};

export default NewPostForm;