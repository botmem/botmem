import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

@Injectable()
export class OllamaService {
  private baseUrl: string;
  private embedModel: string;
  private vlModel: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.ollamaBaseUrl;
    this.embedModel = config.ollamaEmbedModel;
    this.vlModel = config.ollamaVlModel;
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.embedModel, input: text }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama embed failed (${res.status}): ${body}`);
    }

    const data = await res.json();
    return data.embeddings[0];
  }

  async generate(prompt: string, images?: string[]): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.vlModel,
      prompt,
      stream: false,
    };
    if (images?.length) {
      body.images = images;
    }

    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama generate failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    return data.response;
  }
}
