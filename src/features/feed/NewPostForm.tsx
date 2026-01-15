// fileName: src/features/feed/NewPostForm.tsx
import React, { useState, useRef, useEffect, useId } from 'react';
import { Post } from '../../types';
import { AddMediaIcon } from '../../components/Icons';

interface NewPostFormProps {
  onAddPost: (postData: { content: string; referenceCID?: string; file?: File }) => void;
  isProcessing: boolean;
  isCoolingDown: boolean;
  countdown: number;
  replyingToPost: Post | null;
  replyingToAuthorName?: string | null;
  onCancel?: () => void; // Added onCancel prop
}

const NewPostForm: React.FC<NewPostFormProps> = ({
  onAddPost,
  isProcessing,
  isCoolingDown,
  countdown,
  replyingToPost,
  replyingToAuthorName,
  onCancel, // Destructure onCancel
}) => {
  const [content, setContent] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const uniqueId = useId(); 
  const fileInputId = `file-upload-${uniqueId}`;

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setPreviewUrl(URL.createObjectURL(file));
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!content.trim() && !selectedFile) return;

    onAddPost({
      content,
      referenceCID: replyingToPost?.id,
      file: selectedFile || undefined,
    });

    setContent('');
    resetFile();
  };

  const resetFile = () => {
    setSelectedFile(null);
    setPreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const isButtonDisabled = isProcessing || (!content.trim() && !selectedFile);

  let buttonText = "Post";
  if (replyingToPost) buttonText = "Reply";
  if (isProcessing) buttonText = "Processing...";
  else if (isCoolingDown) buttonText = `Post (Publishing... ${countdown}s)`;

  return (
    <form onSubmit={handleSubmit} className="new-post-form">
      {replyingToPost && (
        <div className="reply-to-indicator">
          <span>Replying to {replyingToAuthorName || 'Post'}</span>
        </div>
      )}

      <textarea
        className="new-post-input"
        placeholder={replyingToPost ? "Write your reply..." : "What's happening?"}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        disabled={isProcessing}
        autoFocus={!!replyingToPost} // Auto-focus when opened
      />

      <input
        type="file"
        id={fileInputId} 
        ref={fileInputRef}
        accept="image/*,video/*,.pdf"
        onChange={handleFileChange}
        className="file-input-hidden"
      />

      {(previewUrl || selectedFile) && (
        <div className="media-preview">
          {previewUrl && selectedFile?.type.startsWith('image/') && (
            <img src={previewUrl} alt="Preview" crossOrigin="anonymous"/>
          )}
          {previewUrl && selectedFile?.type.startsWith('video/') && (
            <video src={previewUrl} controls crossOrigin="anonymous"/>
          )}
          {selectedFile?.type === 'application/pdf' && (
            <div className="media-preview-pdf">
               PDF: {selectedFile.name.substring(0, 15)}...
            </div>
          )}
          <button type="button" onClick={resetFile} className="remove-file-button" title="Remove file">×</button>
        </div>
      )}

      <div className="form-footer">
        {/* Cancel Button (Only if onCancel is provided) */}
        {onCancel && (
            <button 
                type="button" 
                onClick={onCancel} 
                className="action-button" // Reuse action-button style or basic styling
                style={{ marginRight: 'auto', color: 'var(--text-secondary-color)', fontSize: '0.9em' }}
            >
                Cancel
            </button>
        )}

        <label htmlFor={fileInputId} className="file-input-label" title="Add Media">
            <AddMediaIcon />
        </label>

        <button type="submit" className="new-post-button" disabled={isButtonDisabled}>
            {buttonText}
        </button>
      </div>
    </form>
  );
};

export default NewPostForm;