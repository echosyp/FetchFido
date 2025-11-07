#!/usr/bin/env python3
#THIS SCRIPT REQUIRES COMMANDLINE ARGUMENTS FOR IP:PORT

import socket
import time
import sys

def send_gps_data(host='albinobigfoot.com', port=9999):
    """Send GPS coordinates to the FetchFido UDP server"""
    
    # Test coordinates (New York City area)
    test_coordinates = [
        "40.7128,-74.0060",  # Times Square
        '{"lat": 40.7589, "lon": -73.9851}',  # Central Park
        "40.7505 -73.9934",  # Empire State Building
        "40.6892,-74.0445",  # Statue of Liberty
    ]
    
    print(f"Sending GPS coordinates to {host}:{port}")
    
    try:
        # Create UDP socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        
        for i, coords in enumerate(test_coordinates, 1):
            print(f"Sending coordinate {i}: {coords}")
            
            # Send the coordinate data
            sock.sendto(coords.encode('utf-8'), (host, port))
            
            # Wait a bit between sends
            time.sleep(2)
            
        print("All coordinates sent successfully!")
        print("Check the web interface at http://192.168.120.13:8080 to see if markers appear on the map.")
        
    except Exception as e:
        print(f"Error sending GPS data: {e}")
        
    finally:
        sock.close()

if __name__ == "__main__":
    # Allow custom host/port
    host = sys.argv[1] if len(sys.argv) > 1 else 'albinobigfoot.com'
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 9999
    
    send_gps_data(host, port)