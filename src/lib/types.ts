import type { BlackCard, WhiteCard } from './cards';

export interface Game {
  id: string;
  name: string;
  state: 'waiting' | 'active' | 'finished';
  current_round: number;
  max_rounds: number;
  czar_rotation: string[];
  czar_index: number;
  deck: WhiteCard[];
  discard_pile: WhiteCard[];
  created_by: string;
  created_at: string;
}

export interface GamePlayer {
  id: string;
  game_id: string;
  user_id: string;
  display_name: string;
  score: number;
  hand: WhiteCard[];
  is_czar: boolean;
  has_submitted: boolean;
  is_ready: boolean;
  joined_at: string;
}

export interface Round {
  id: string;
  game_id: string;
  round_number: number;
  black_card: BlackCard;
  status: 'submitting' | 'judging' | 'finished';
  czar_id: string | null;
  winner_id: string | null;
  timer_ends_at: string | null;
  created_at: string;
}

export interface Submission {
  id: string;
  round_id: string;
  game_id: string;
  player_id: string;
  user_id: string;
  cards: WhiteCard[];
  votes: number;
  voter_ids: string[];
  is_winner: boolean;
  created_at: string;
}
