import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useMapsLibrary } from '@vis.gl/react-google-maps';
import { MapPin, Search, Loader2, X } from 'lucide-react';
import { apiFetchJson } from '../lib/aqiUtils';
import { getErrorMessage } from '../lib/airQualityDomain';

export interface SelectedPlace {
  label: string;
  lat: number;
  lng: number;
}

interface PlaceSearchInputProps {
  value: string;
  onSelect: (place: SelectedPlace) => void;
  placeholder?: string;
  biasLat?: number;
  biasLng?: number;
  id?: string;
}

export const PlaceSearchInput: React.FC<PlaceSearchInputProps> = ({
  value,
  onSelect,
  placeholder = 'Search neighborhood, street, or address...',
  biasLat,
  biasLng,
  id,
}) => {
  const placesLib = useMapsLibrary('places');
  const sessionTokenRef = useRef<google.maps.places.AutocompleteSessionToken | null>(null);

  const [inputValue, setInputValue] = useState(value);
  const [suggestions, setSuggestions] = useState<google.maps.places.AutocompleteSuggestion[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setInputValue(value);
  }, [value]);

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  useEffect(() => {
    const trimmed = inputValue.trim();
    if (!placesLib || !isOpen || trimmed.length < 2) {
      if (trimmed.length < 2) setSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        setIsLoading(true);
        setSearchError(null);
        const { AutocompleteSessionToken, AutocompleteSuggestion } = placesLib;
        if (!sessionTokenRef.current) {
          sessionTokenRef.current = new AutocompleteSessionToken();
        }
        const request: google.maps.places.AutocompleteRequest = {
          input: trimmed,
          sessionToken: sessionTokenRef.current,
        };
        if (typeof biasLat === 'number' && typeof biasLng === 'number') {
          request.origin = { lat: biasLat, lng: biasLng };
        }
        const res = await AutocompleteSuggestion.fetchAutocompleteSuggestions(request);
        if (!cancelled) {
          setSuggestions(res.suggestions || []);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const msg = getErrorMessage(err, String(err));
          if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('OVER_QUERY_LIMIT')) {
            window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
          }
          setSuggestions([]);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }, 240);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [placesLib, inputValue, isOpen, biasLat, biasLng]);

  const handleSuggestionPick = useCallback(
    async (suggestion: google.maps.places.AutocompleteSuggestion) => {
      if (!suggestion.placePrediction) return;
      try {
        setIsLoading(true);
        setSearchError(null);
        const place = suggestion.placePrediction.toPlace();
        await place.fetchFields({
          fields: ['displayName', 'formattedAddress', 'location'],
        });
        const loc = place.location;
        if (loc) {
          const label =
            place.formattedAddress ||
            place.displayName ||
            suggestion.placePrediction.text.text;
          setInputValue(label);
          setIsOpen(false);
          sessionTokenRef.current = null;
          setSuggestions([]);
          onSelect({ label, lat: loc.lat(), lng: loc.lng() });
        }
      } catch (err: unknown) {
        const msg = getErrorMessage(err, String(err));
        if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('OVER_QUERY_LIMIT')) {
          window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
        }
        setSearchError('Could not load coordinates for that place.');
      } finally {
        setIsLoading(false);
      }
    },
    [onSelect]
  );

  const handleManualEnter = async () => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    try {
      setIsLoading(true);
      setSearchError(null);
      const data = await apiFetchJson<{
        places: Array<{ name: string; address: string; lat: number; lng: number }>;
      }>('/api/places/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed, lat: biasLat, lng: biasLng }),
      });
      const first = data.places?.[0];
      if (first && Number.isFinite(first.lat) && Number.isFinite(first.lng)) {
        const label = first.address || first.name;
        setInputValue(label);
        setIsOpen(false);
        setSuggestions([]);
        onSelect({ label, lat: first.lat, lng: first.lng });
      } else {
        setSearchError('No matching location found. Try a street or neighborhood name.');
      }
    } catch (err: unknown) {
      setSearchError(getErrorMessage(err, 'Location search failed.'));
    } finally {
      setIsLoading(false);
    }
  };

  const listboxId = id ? `${id}-listbox` : 'place-search-listbox';

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="relative flex items-center">
        <Search className="w-4 h-4 text-[#4B5E59] absolute left-3.5 pointer-events-none" aria-hidden="true" />
        <input
          id={id}
          type="text"
          role="combobox"
          aria-expanded={isOpen && suggestions.length > 0}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-label={placeholder}
          value={inputValue}
          onFocus={() => setIsOpen(true)}
          onChange={(e) => {
            setInputValue(e.target.value);
            setIsOpen(true);
            setSearchError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void handleManualEnter();
            }
          }}
          placeholder={placeholder}
          autoComplete="off"
          className="w-full min-h-[44px] pl-10 pr-10 py-2.5 rounded-xl bg-[#F6F8F7] border border-slate-200 text-sm text-[#0F1D1A] placeholder:text-[#6B7E79] focus:outline-none focus:ring-2 focus:ring-[#0E6B5E]/25 focus:border-[#0E6B5E] transition-colors"
        />
        {isLoading ? (
          <Loader2 className="w-4 h-4 text-[#0E6B5E] animate-spin absolute right-3.5" />
        ) : inputValue ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setInputValue('');
              setSuggestions([]);
              setSearchError(null);
            }}
            className="absolute right-1.5 min-w-[36px] min-h-[36px] flex items-center justify-center text-[#4B5E59] hover:text-[#0F1D1A] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        ) : null}
      </div>

      {searchError && (
        <p role="alert" className="mt-1.5 text-xs text-red-700">
          {searchError}
        </p>
      )}

      {isOpen && suggestions.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Place suggestions"
          className="absolute z-40 mt-1.5 w-full bg-white rounded-xl border border-slate-200 shadow-lg overflow-hidden divide-y divide-slate-100"
        >
          {suggestions.slice(0, 5).map((suggestion, idx) => (
            <li key={suggestion.placePrediction?.placeId || idx} role="option" aria-selected={false}>
              <button
                type="button"
                onClick={() => void handleSuggestionPick(suggestion)}
                className="w-full text-left px-3.5 py-3 min-h-[44px] flex items-start gap-2.5 hover:bg-[#F6F8F7] transition-colors cursor-pointer"
              >
                <MapPin className="w-4 h-4 text-[#0E6B5E] shrink-0 mt-0.5" />
                <span className="text-sm text-[#0F1D1A] leading-snug">
                  {suggestion.placePrediction?.text.text}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
