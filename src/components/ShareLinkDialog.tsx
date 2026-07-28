import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import toast from 'react-hot-toast';

interface ShareLinkDialogProps {
    url: string;
    title?: string;
    onClose: () => void;
}

const ShareLinkDialog: React.FC<ShareLinkDialogProps> = ({
    url,
    title = 'Share',
    onClose,
}) => {
    const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setQrDataUrl(null);
        QRCode.toDataURL(url, {
            width: 240,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
        })
            .then((dataUrl) => {
                if (!cancelled) setQrDataUrl(dataUrl);
            })
            .catch((e) => {
                console.warn('[Share] QR generate failed', e);
                if (!cancelled) toast.error('Could not generate QR code');
            });
        return () => {
            cancelled = true;
        };
    }, [url]);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(url);
            toast.success('Link copied!');
        } catch {
            toast.error('Could not copy link');
        }
    };

    return (
        <div
            className="expanded-post-backdrop dialog-backdrop"
            onClick={onClose}
            role="presentation"
        >
            <div
                className="expanded-post-container dialog-container share-link-dialog"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={title}
            >
                <h2 style={{ marginTop: 0 }}>{title}</h2>
                <div className="share-link-qr-wrap">
                    {qrDataUrl ? (
                        <img src={qrDataUrl} alt="QR code for share link" className="share-link-qr" />
                    ) : (
                        <div className="share-link-qr share-link-qr--loading">Generating QR…</div>
                    )}
                </div>
                <p className="share-link-url" title={url}>
                    {url}
                </p>
                <div className="dialog-buttons">
                    <button type="button" className="dialog-btn-retry" onClick={handleCopy}>
                        Copy link
                    </button>
                    <button type="button" className="dialog-btn-init" onClick={onClose}>
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ShareLinkDialog;
