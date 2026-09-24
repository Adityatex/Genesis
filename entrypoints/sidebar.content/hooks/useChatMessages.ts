// entrypoints/sidebar.content/hooks/useChatMessages.ts
import { useState, useRef, useEffect } from 'react';

export type Message = { type: 'user' | 'bot'; text: string; id: string; isLoading?: boolean };

export function useChatMessages() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [pageText, setPageText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const addBotMessage = (text: string, isLoading = false) => {
    const id = Date.now().toString() + Math.random();
    setMessages((prev) => [...prev, { type: 'bot', text, id, isLoading }]);
    return id;
  };

  const updateBotMessage = (id: string, text: string, isLoading = false) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text, isLoading } : m)));
  };

  const pushUserMessage = (text: string) => {
    setMessages((prev) => [...prev, { type: 'user', text, id: Date.now().toString() }]);
  };

  return { messages, setMessages, pageText, setPageText, messagesEndRef, addBotMessage, updateBotMessage, pushUserMessage };
}
