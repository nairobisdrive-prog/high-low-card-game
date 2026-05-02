/*
  # Create Cards Against Humanity Game Schema

  1. New Tables
    - `games` - Game sessions
    - `game_players` - Players in each game
    - `rounds` - Each round of play
    - `submissions` - Card submissions per round

  2. Security
    - Enable RLS on all tables
    - Policies for authenticated users

  3. Realtime
    - All tables added to realtime publication
*/

-- Games table
CREATE TABLE IF NOT EXISTS games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'waiting',
  current_round integer NOT NULL DEFAULT 0,
  max_rounds integer NOT NULL DEFAULT 10,
  czar_rotation jsonb NOT NULL DEFAULT '[]'::jsonb,
  czar_index integer NOT NULL DEFAULT -1,
  deck jsonb NOT NULL DEFAULT '[]'::jsonb,
  discard_pile jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

-- Game players table
CREATE TABLE IF NOT EXISTS game_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  display_name text NOT NULL DEFAULT '',
  score integer NOT NULL DEFAULT 0,
  hand jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_czar boolean NOT NULL DEFAULT false,
  has_submitted boolean NOT NULL DEFAULT false,
  is_ready boolean NOT NULL DEFAULT false,
  joined_at timestamptz DEFAULT now(),
  UNIQUE(game_id, user_id)
);

-- Rounds table
CREATE TABLE IF NOT EXISTS rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  round_number integer NOT NULL DEFAULT 1,
  black_card jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'submitting',
  czar_id uuid REFERENCES auth.users(id),
  winner_id uuid,
  timer_ends_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Submissions table
CREATE TABLE IF NOT EXISTS submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id uuid NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES game_players(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  cards jsonb NOT NULL DEFAULT '[]'::jsonb,
  votes integer NOT NULL DEFAULT 0,
  is_winner boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE(round_id, player_id)
);

-- Enable RLS
ALTER TABLE games ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;

-- Games policies
CREATE POLICY "Authenticated users can view games"
  ON games FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can create games"
  ON games FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Game participants can update games"
  ON games FOR UPDATE
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM game_players
    WHERE game_players.game_id = games.id
    AND game_players.user_id = auth.uid()
  ));

CREATE POLICY "Game participants can delete games"
  ON games FOR DELETE
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM game_players
    WHERE game_players.game_id = games.id
    AND game_players.user_id = auth.uid()
  ));

-- Game players policies
CREATE POLICY "Authenticated users can view game players"
  ON game_players FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can join games"
  ON game_players FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own player data"
  ON game_players FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can leave games"
  ON game_players FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- Rounds policies
CREATE POLICY "Authenticated users can view rounds"
  ON rounds FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Game participants can create rounds"
  ON rounds FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM game_players
    WHERE game_players.game_id = rounds.game_id
    AND game_players.user_id = auth.uid()
  ));

CREATE POLICY "Game participants can update rounds"
  ON rounds FOR UPDATE
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM game_players
    WHERE game_players.game_id = rounds.game_id
    AND game_players.user_id = auth.uid()
  ));

-- Submissions policies
CREATE POLICY "Authenticated users can view submissions"
  ON submissions FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can submit cards"
  ON submissions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Game participants can update submissions"
  ON submissions FOR UPDATE
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM game_players
    WHERE game_players.game_id = submissions.game_id
    AND game_players.user_id = auth.uid()
  ));

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE games;
ALTER PUBLICATION supabase_realtime ADD TABLE game_players;
ALTER PUBLICATION supabase_realtime ADD TABLE rounds;
ALTER PUBLICATION supabase_realtime ADD TABLE submissions;
