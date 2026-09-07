import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
export default function Modal({ title, description, children, onClose, wide = false }) {
  return <Dialog open onOpenChange={open => !open && onClose()}><DialogContent className={`rounded-2xl bg-[#fdfdfb] max-h-[90vh] overflow-y-auto ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'}`}><DialogHeader><DialogTitle className="font-heading text-2xl font-normal">{title}</DialogTitle><DialogDescription>{description || 'School records · Your private workspace'}</DialogDescription></DialogHeader>{children}</DialogContent></Dialog>;
}