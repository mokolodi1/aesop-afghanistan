import re
import phonenumbers
from phonenumbers.phonenumberutil import NumberParseException

class PhoneNumberParser:

    # Called by parse_to_valid_whatsapp when it doesn't work at
    # first. parse_to_valid_whatsapp has already removed any
    # non-digit characters.
    @staticmethod
    def start_parsing_by_hand(difficult_string, buddy_type, iteration=1):
        country = 'default'
        print ('started parsing by hand')

        if difficult_string.startswith('00'):
            difficult_string = difficult_string[2:]
        
        # Special cases for Afghan numbers without country codes
        if len(difficult_string) == 9:
            if difficult_string.startswith('760') or difficult.string.startswith('740'):
                difficult_string = '93' + difficult_string
                country = 'Afghanistan'
        # Assume Afghan buddies have Afghan country codes
        if buddy_type == 'Afghan':
            if not difficult_string.startswith('93'):
                difficult_string = '93' + difficult_string
                country = 'Afghanistan'

        
        if buddy_type == 'English' and len(difficult_string) == 10:
            if not difficult_string.startswith(('1', '44', '93')):
                difficult_string = 1 + difficult_string

        difficult_string = '+' + difficult_string
        print ('parse by hand result is ' + difficult_string)

        return PhoneNumberParser.parse_to_valid_whatsapp(difficult_string, buddy_type, iteration)

    @staticmethod
    def parse_to_valid_whatsapp(unparsed_number, buddy_type, iteration=0):
        
        # Use phonenumbers package on raw input if possible
        try: 
            parsed_number = phonenumbers.parse(unparsed_number, None)
            print('I parsed!')
            return phonenumbers.format_number(parsed_number, phonenumbers.PhoneNumberFormat.E164)
        except NumberParseException as e:
            
            # Prevent infinite loops
            if iteration > 1:
                return 'Failed, even after attempt to parse by hand'
            
            print(unparsed_number, 'failed first parse')
            digits_only = re.sub(r'[\s\D]', '', unparsed_number)

            try:
                parsed_number = phonenumbers.parse(digits_only, None)
                print('Parsed after removing non-digit chars')
                return phonenumbers.format_number(parsed_number, phonenumbers.PhoneNumberFormat.E164)
            
            except NumberParseException as e:
                print(e)
                print(digits_only + 'Couldnt parse after removing non-digit chars')
                return PhoneNumberParser.start_parsing_by_hand(digits_only, buddy_type, iteration=iteration + 1)

print(PhoneNumberParser.parse_to_valid_whatsapp('+89020000000', 'None'))


'''
        print (phone_number)
        # Remove any non-digit characters from the phone number with regex

        print(digits_only)

        # Special cases for Afghan numbers without country codes
        if digits_only.startswith('760'):
            return '+93' + digits_only
        elif digits_only.startswith('740'):
            return '+93' + digits_only

        # If the phone number starts with '00', remove the leading '00'
        if digits_only.startswith('00'):
            digits_only = digits_only[2:]
        
        # Dictionary mapping country codes to their respective international dialing codes
        country_codes = {
            '1': '+1',  # United States
            '44': '+44',  # United Kingdom
            '93': '+93', # Afghanistan
            # Add more country codes as needed
        }

        # Iterate over country codes to find a match
        for code, dialing_code in country_codes.items():
            if digits_only.startswith(code):
                # Get the city code and local number
                city_code = digits_only[len(code):len(code) + 3]
                local_number = digits_only[len(code) + 3:]
                
                # Construct the full international format with leading zeros retained
                
                print(f'{dialing_code}{city_code}{local_number}'.strip())

                return f'{dialing_code}{city_code}{local_number}'.strip()  # Strip any whitespace



        ready_for_phonenumbers_module = '+' + digits_only
        return ready_for_phonenumbers_module
        parsed_number = phonenumbers.parse(ready_for_phonenumbers_module, 
None)
        return phonenumbers.format_number(parsed_number, phonenumbers.PhoneNumberFormat.E164) 
'''